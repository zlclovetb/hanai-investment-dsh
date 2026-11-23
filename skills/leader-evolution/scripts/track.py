"""Read frozen Hanai evidence or reconcile a normalized A-share snapshot."""

import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
import math
import os
import operator
from pathlib import Path
import re
import sqlite3
import sys
from tempfile import NamedTemporaryFile

BEIJING = timezone(timedelta(hours=8))
ROLES = ("总龙候选", "次龙/卡位候选", "中军/容量", "补涨/跟风")
CONFIDENCE = ("低", "中", "高")
STATES = ("DORMANT", "IGNITION", "MAIN_RALLY", "DIFFUSION", "DIVERGENCE", "EBB")
OPS = {"==": operator.eq, ">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le}
NUMERIC = """boards space_boards turnover_pct breaks first_seal_minute volume_ma5_ratio volume_prev_ratio
auction_prev_pct open30_change_pct change_pct amount amount_ma5_ratio theme_limit_down
theme_followers followers_delta followers_shrink_days""".split()
BOOLEAN = """promoted failed_unsealed first_break resealed countertrend_limit_up
prev_broken prev_long_leg prev_late_seal prev_high_volume_one_word front_row_big_loss
mid_tier_loss_cluster followers_limit_down_cluster market_leader_holds capacity_breakdown""".split()
METRICS = set(NUMERIC + BOOLEAN)
WEAK = ("prev_broken", "prev_long_leg", "prev_late_seal", "prev_high_volume_one_word")
ATTENTION = {
    "first_break": ("首次断板", "核验次日是否回封及前排能否接力"),
    "resealed": ("开板后回封", "核验次日首封时点和开板次数"),
    "countertrend_limit_up": ("分歧时逆势封板", "核验卡位股能否晋级及跟随家数能否增加"),
    "followers_shrink_days": ("跟风家数连续两日收缩", "核验次日同口径跟随家数是否止跌"),
}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def timestamp(value):
    stamp = datetime.fromisoformat(value)
    check(stamp.utcoffset() is not None, "时间须包含时区")
    return stamp.astimezone(BEIJING)


def key(candidate):
    return f"{candidate['theme']}/{candidate['code']}"


def clauses_valid(clauses):
    check(isinstance(clauses, list) and clauses, "条件至少需要一项可观察指标")
    for part in clauses:
        metric, op, value = part["metric"], part["op"], part["value"]
        check(metric in METRICS and op in OPS, f"未知条件或运算符：{metric} {op}")
        check(type(value) is bool and op == "==" if metric in BOOLEAN else
              type(value) in (int, float) and math.isfinite(value), f"条件值类型错误：{metric}")


def candidate_valid(candidate, proposal=False):
    check(re.fullmatch(r"[0-9]{6}", candidate["code"]) and candidate["theme"].strip()
          and "/" not in candidate["theme"] and candidate["name"].strip(), "候选需有题材、六位代码与名称")
    check(candidate["role"] in ROLES and candidate["confidence"] in CONFIDENCE, "层级或确信度无效")
    check(type(candidate["weight"]) is int and 1 <= candidate["weight"] <= 5, "权重须为 1 至 5 的整数")
    check(candidate["falsifiers"], f"{key(candidate)} 缺少证伪条件")
    for rule in candidate["falsifiers"]:
        check(rule["label"].strip() and rule["action"] in ("撤销", "降级"), "证伪需有名称及动作")
        if rule["action"] == "降级":
            check(rule.get("toRole") in ROLES and rule["toRole"] != candidate["role"]
                  and rule.get("afterFalsifiers"), "降级须给出目标角色及新角色的证伪条件")
            for successor in rule["afterFalsifiers"]:
                check(successor["label"].strip() and successor["action"] == "撤销", "新角色证伪动作须为撤销")
                clauses_valid(successor["all"])
        clauses_valid(rule["all"])
    if proposal:
        check(candidate["reason"].strip(), "框架外观察须说明新信号")
        clauses_valid(candidate["admitWhen"])
        check(len({part["metric"] for part in candidate["admitWhen"]}) >= 2, "框架外纳入须有两项独立指标")


def evaluated(clauses, metrics):
    states, evidence, gaps = [], set(), []
    for part in clauses:
        metric = part["metric"]
        fact = metrics.get(metric)
        if fact is None:
            gaps.append(metric)
            continue
        states.append(OPS[part["op"]](fact["value"], part["value"]))
        evidence.update(fact["evidence"])
    return (False if False in states else None if gaps else True), sorted(evidence), gaps


def condition(metric, op, value):
    return {"metric": metric, "op": op, "value": value}


def signals(facts):
    def fact(metric):
        return facts.get(metric, {}).get("value")

    yesterday = [fact(metric) for metric in WEAK]
    auction, seal, ratio = (fact(key) for key in ("auction_prev_pct", "first_seal_minute", "volume_prev_ratio"))
    limit_down, front_loss = fact("theme_limit_down"), fact("front_row_big_loss")
    weak_status = "昨日未见弱势形态" if all(value is False for value in yesterday) else "待核验"
    if any(value is True for value in yesterday):
        if (limit_down is not None and limit_down >= 2) or front_loss is True:
            weak_status = "板块负反馈，信号作废"
        elif None not in (auction, seal, ratio, limit_down, front_loss):
            weak_status = "满足" if auction >= 5 and 570 <= seal <= 600 and 0 < ratio < 1 else "未满足"
    breaks, ma5 = fact("breaks"), fact("volume_ma5_ratio")
    veto = (seal is not None and seal >= 870) or (breaks is not None and breaks >= 2 and ma5 is not None and ma5 >= 2.5)
    quality = "否决升级" if veto else "可参与升级" if (
        seal is not None and 570 <= seal < 870 and breaks is not None
        and (breaks < 2 or ma5 is not None)) else "待核验"
    return weak_status, quality


def get_facts(snapshot, cutoff):
    result = {}
    for entity, metrics in snapshot["facts"].items():
        result[entity] = {}
        for metric, fact in metrics.items():
            check(metric in METRICS, f"未知快照指标：{metric}")
            value = fact["value"]
            if value is None:
                continue
            observed = timestamp(fact["observedAt"])
            trading_date = snapshot.get("previousDate") if metric.startswith("prev_") else snapshot["date"]
            check(trading_date == observed.date().isoformat() and observed <= cutoff,
                  f"{entity} {metric} 的时点不属于对应交易日或晚于截止时间")
            check(isinstance(fact["evidence"], list) and bool(fact["evidence"])
                  and all(isinstance(item, str) and item.strip() for item in fact["evidence"]), "事实须有证据引用")
            check(type(value) is bool if metric in BOOLEAN else type(value) in (int, float) and math.isfinite(value), f"事实值类型错误：{metric}")
            result[entity][metric] = fact
    return result


def reconcile(snapshot, prior, baseline=False):
    mode, day = snapshot["mode"], snapshot["date"]
    cutoff = timestamp(snapshot["asOf"])
    previous_day = snapshot.get("previousDate")
    check(cutoff.date().isoformat() == day and mode in ("close", "intraday"), "日期或模式无效")
    check(previous_day is None or date.fromisoformat(previous_day) < cutoff.date(), "上一交易日必须早于当日")
    check(mode != "close" or cutoff.time() >= time(15), "收盘纠错必须在北京时间 15:00 后")
    check((prior is None and baseline and mode == "close") or (prior is not None and not baseline
          and prior["mode"] == "close" and prior["date"] == previous_day), "须给出上一交易日收盘状态，或显式建立首日基线")

    today_facts = get_facts(snapshot, cutoff)
    prior = prior or {}
    starting = prior.get("candidates", snapshot.get("candidates", []))
    if not baseline:
        check(not snapshot.get("candidates"), "旧候选由昨日状态继承，新增证券请用 proposals")
    proposals = snapshot.get("proposals", [])
    previous_watch = prior.get("observations", [])
    for group, is_proposal in ((starting, False), (proposals, True), (previous_watch, True)):
        for candidate in group:
            candidate_valid(candidate, is_proposal)
        check(len({key(candidate) for candidate in group}) == len(group), "同题材内候选代码重复")
    check(not {key(candidate) for candidate in starting} & {key(candidate) for candidate in previous_watch},
          "上一日的活跃候选与观察项重叠")

    updated, journal, alerts, watch = [], [], [], []
    known = {key(candidate) for candidate in starting + previous_watch}
    risk_themes = set()
    for candidate in starting:
        entity, theme = key(candidate), candidate["theme"]
        facts = today_facts.get(entity, {})
        weak, quality = signals(facts)
        checks = []
        for rule in candidate["falsifiers"]:
            hit, evidence, gaps = evaluated(rule["all"], facts)
            result = "次日验证" if baseline else "触发" if hit else "待核验" if hit is None else "未触发"
            checks.append({"condition": rule["label"], "result": result,
                           "evidence": evidence, "missing": gaps})
        triggered = [(rule, result) for rule, result in zip(candidate["falsifiers"], checks) if result["result"] == "触发"]
        fired = next((pair for pair in triggered if pair[0]["action"] == "撤销"), triggered[0] if triggered else None)
        below = evaluated([condition("failed_unsealed", "==", True)], facts)[0]
        narrowing = evaluated([condition("followers_delta", "<", 0)], facts)[0]
        advancing = evaluated([condition("promoted", "==", True), condition("followers_delta", ">=", 0)], facts)[0]
        tail = evaluated([condition("followers_limit_down_cluster", "==", True), condition("market_leader_holds", "==", True)], facts)
        retreat = evaluated([condition("failed_unsealed", "==", True), condition("turnover_pct", ">", 40),
                             condition("mid_tier_loss_cluster", "==", True), condition("theme_limit_down", ">=", 2)], facts) \
            if candidate["role"] == "总龙候选" else (False, [], [])
        risk = tail if tail[0] else retreat
        if mode == "close" and (fired or risk[0]):
            reason = fired[0]["label"] if fired else "补涨先退潮" if tail[0] else "退潮组合触发"
            alert = {"level": "L3", "theme": theme, "code": candidate["code"], "reason": reason,
                     "action": "停止在该题材内新开仓", "evidence": sorted(set((fired[1]["evidence"] if fired else []) + (risk[1] if risk[0] else [])))}
            alerts.append(alert)
            risk_themes.add(theme)
        else:
            for metric, (reason, verify_next) in ATTENTION.items():
                item = facts.get(metric)
                if item is None or not (item["value"] >= 2 if metric == "followers_shrink_days" else item["value"] is True):
                    continue
                alerts.append({"level": "L2", "theme": theme, "code": candidate["code"], "reason": reason,
                               "verifyNext": verify_next, "evidence": item["evidence"]})
            if fired or risk[0]:
                alerts.append({"level": "L2", "theme": theme, "code": candidate["code"], "reason": "盘中事实偏离",
                               "verifyNext": "收盘复核完整条件，次日验证前排承接与回封",
                               "evidence": sorted(set((fired[1]["evidence"] if fired else []) + (risk[1] if risk[0] else [])))})
        journal.append({"key": entity, "weakToStrong": weak, "sealQuality": quality, "checks": checks,
                        "metrics": facts, "below": below, "narrowing": narrowing, "advancing": advancing, "fired": fired})

    for candidate, review in zip(starting, journal):
        fired = review.pop("fired")
        below, narrowing, advancing = (review.pop(metric) for metric in ("below", "narrowing", "advancing"))
        row = dict(candidate)
        direction, reason = "维持", "证据不足或未满足调整条件"
        if mode == "intraday":
            direction, reason = "盘中记录", "等待收盘事实"
        elif fired:
            rule, _ = fired
            direction, reason = rule["action"], rule["label"]
            if direction == "降级":
                row.update(role=rule["toRole"], confidence="低", weight=1, falsifiers=rule["afterFalsifiers"])
        elif baseline:
            direction, reason = "建立基线", "首日候选，等待下一交易日清算"
        elif below or narrowing:
            direction, reason = "下调", "断板未回封" if below else "跟风家数收缩"
        elif candidate["theme"] not in risk_themes and review["sealQuality"] == "可参与升级" and (
                advancing or review["weakToStrong"] == "满足") and not any(
                    item["result"] == "待核验" for item in review["checks"]):
            if candidate["confidence"] != "高" or candidate["weight"] < 5:
                direction, reason = "上调", "晋级且带动未减弱" if advancing else "弱转强完成"
        if direction in ("上调", "下调"):
            delta = 1 if direction == "上调" else -1
            row.update(confidence=CONFIDENCE[min(2, max(0, CONFIDENCE.index(row["confidence"]) + delta))],
                       weight=min(5, max(1, row["weight"] + delta)))
        review.update(action=direction, reason=reason, previousConfidence=candidate["confidence"],
                      confidence=None if direction == "撤销" else row["confidence"])
        if direction != "撤销":
            updated.append(row)

    for candidate in previous_watch:
        facts = today_facts.get(key(candidate), {})
        hit, evidence, gaps = evaluated(candidate["admitWhen"], facts)
        quality = signals(facts)[1]
        valid = all(evaluated(rule["all"], facts)[0] is False for rule in candidate["falsifiers"])
        admitted = mode == "close" and hit is True and valid and quality == "可参与升级" and candidate["theme"] not in risk_themes
        if admitted:
            row = {name: value for name, value in candidate.items() if name not in ("reason", "admitWhen")}
            updated.append({**row, "confidence": "低", "weight": 1})
            journal.append({"key": key(candidate), "action": "纳入试错", "reason": candidate["reason"], "evidence": evidence, "metrics": facts})
        else:
            watch.append({**candidate, "verification": "盘中待收盘" if mode == "intraday" else
                          "待核验" if gaps or quality == "待核验" else "未达纳入条件"})
    watch.extend({**candidate, "verification": "次日验证"} for candidate in proposals if key(candidate) not in known)
    alerts.sort(key=lambda alert: alert["level"], reverse=True)
    report = {"date": day, "previousDate": previous_day, "asOf": snapshot["asOf"], "mode": mode, "candidates": updated,
              "journal": journal, "observations": watch, "alerts": alerts}
    if mode == "close" and snapshot.get("themes"):
        themes = snapshot["themes"]
        for theme, summary in themes.items():
            check(isinstance(theme, str) and 0 < len(theme.strip()) <= 240 and summary["state"] in STATES,
                  "题材阶段无效")
            check(0 < len(summary["conclusion"].strip()) <= 500, "题材须有一句收盘结论")
            check("rule" not in summary or 0 < len(summary["rule"].strip()) <= 500, "节点规则无效")
            check(isinstance(summary["evidence"], list) and 0 < len(summary["evidence"]) <= 24
                  and all(isinstance(ref, str) and 0 < len(ref.strip()) <= 500 for ref in summary["evidence"]),
                  "题材结论须有证据引用")
        report["themes"] = themes
    return report


def publish_hanai(root, report):
    check(report["mode"] == "close", "盘中结果不可发布为收盘清算")
    exports = root / "exports"
    check(exports.is_dir() and not exports.is_symlink(), "指定目录不是已初始化的 Hanai 数据目录")
    folder = exports / "leader-evolution"
    folder.mkdir(exist_ok=True)
    check(folder.is_dir() and not folder.is_symlink(), "清算目录不是独立的本地目录")
    target = folder / (report["date"] + ".json")
    data = (json.dumps(report, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    check(len(data) <= 192_000, "清算记录超出工作台读取上限")
    temp = None
    try:
        with NamedTemporaryFile(dir=folder, delete=False) as handle:
            temp = Path(handle.name)
            handle.write(data)
        try:
            os.link(temp, target)
        except FileExistsError:
            check(not target.is_symlink() and target.is_file() and target.stat().st_size == len(data)
                  and target.read_bytes() == data, "同日已有不同清算记录，请保留原档并核对差异")
    finally:
        if temp is not None:
            temp.unlink()


def export_hanai(database, day):
    check(date.fromisoformat(day).isoformat() == day, "交易日须使用 YYYY-MM-DD")
    with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT input FROM topic_cycle_daily WHERE date = ?", (day,)).fetchone()
    check(row is not None, f"{day} 没有已冻结复盘")
    frozen = json.loads(row[0])
    evidence = [item for item in frozen["evidence"] if item["date"] <= day]
    ids = {item["id"] for item in evidence}
    return {"date": day, "coverage": frozen.get("coverage", []),
            "evidence": evidence, "facts": [item for item in frozen["facts"] if item["id"] in ids]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", nargs="?", type=Path)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--export-hanai", type=Path, metavar="SQLITE")
    parser.add_argument("--date")
    parser.add_argument("--publish-hanai", type=Path, metavar="DATA_ROOT")
    args = parser.parse_args()
    try:
        if args.export_hanai:
            check(args.date and not (args.snapshot or args.previous or args.baseline or args.publish_hanai), "导出请仅指定 --export-hanai 和 --date")
            output = export_hanai(args.export_hanai, args.date)
        else:
            check(args.snapshot and not args.date, "请提供标准化的快照 JSON")
            load = lambda path: json.loads(path.read_text(encoding="utf-8-sig"))
            output = reconcile(load(args.snapshot), load(args.previous) if args.previous else None, args.baseline)
            if args.publish_hanai:
                publish_hanai(args.publish_hanai, output)
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(output, ensure_ascii=False, allow_nan=False, indent=2))
    except (ValueError, KeyError, AttributeError, TypeError, OSError, sqlite3.Error) as cause:
        parser.exit(2, f"数据校验失败：{cause}\n")


if __name__ == "__main__":
    main()
