import unittest
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from track import condition, publish_hanai, reconcile


YESTERDAY = "2026-11-17"
TODAY = "2026-11-18"
THEME = "试验题材"


def candidate(code="000001"):
    return {"code": code, "name": "样本" + code, "theme": THEME, "role": "总龙候选",
            "weight": 3, "confidence": "中", "falsifiers": [
                {"label": "跌停潮且断板未回封", "action": "撤销", "all": [
                    condition("theme_limit_down", ">=", 2), condition("failed_unsealed", "==", True)]}]}


def facts(**values):
    return {k: {"value": v, "observedAt": f"{YESTERDAY if k.startswith('prev_') else TODAY}T15:00:00+08:00",
                "evidence": [f"fixture:{k}"]} for k, v in values.items()}


def snapshot(metrics=None, **fields):
    return {"date": TODAY, "previousDate": YESTERDAY, "asOf": TODAY + "T15:20:00+08:00",
            "mode": "close", "facts": metrics or {}, **fields}


def prior(*candidates, observations=None):
    return {"date": YESTERDAY, "mode": "close", "candidates": list(candidates), "observations": observations or []}


class TrackingTest(unittest.TestCase):
    def test_close_applies_yesterdays_falsification_and_pushes_l3_first(self):
        first, second = candidate(), candidate("000002")
        metrics = {f"{THEME}/000001": facts(theme_limit_down=2, failed_unsealed=True),
                   f"{THEME}/000002": facts(theme_limit_down=2, failed_unsealed=False, promoted=True,
                                          followers_delta=1, resealed=True, breaks=0, first_seal_minute=580)}
        result = reconcile(snapshot(metrics), prior(first, second))
        self.assertEqual(result["candidates"], [second])
        self.assertEqual([item["action"] for item in result["journal"]], ["撤销", "维持"])
        self.assertEqual([alert["level"] for alert in result["alerts"]], ["L3", "L2"])
        self.assertEqual(result["alerts"][0]["action"], "停止在该题材内新开仓")

    def test_intraday_keeps_previous_state_even_when_condition_matches(self):
        metrics = facts(theme_limit_down=2, failed_unsealed=True)
        for item in metrics.values():
            item["observedAt"] = TODAY + "T10:00:00+08:00"
        result = reconcile(snapshot({f"{THEME}/000001": metrics}, mode="intraday", asOf=TODAY + "T10:00:00+08:00"),
                           prior(candidate()))
        self.assertEqual(result["candidates"], [candidate()])
        self.assertEqual(result["journal"][0]["action"], "盘中记录")
        self.assertEqual(result["alerts"][0]["level"], "L2")

    def test_missing_fact_is_unknown_and_has_no_forced_upgrade(self):
        result = reconcile(snapshot({f"{THEME}/000001": facts(failed_unsealed=True)}), prior(candidate()))
        self.assertEqual(result["journal"][0]["checks"][0]["result"], "待核验")
        self.assertEqual(result["journal"][0]["action"], "下调")
        self.assertEqual(result["alerts"], [])

    def test_weak_to_strong_can_upgrade_but_a_tail_seal_or_cluster_cannot(self):
        common = dict(prev_broken=True, auction_prev_pct=6, first_seal_minute=590,
                      volume_prev_ratio=0.8, breaks=1, theme_limit_down=0, front_row_big_loss=False)
        for changes, direction, weak in [
            ({}, "上调", "满足"),
            ({"first_seal_minute": 875, "promoted": True, "followers_delta": 1}, "维持", "未满足"),
            ({"breaks": 3, "volume_ma5_ratio": 3}, "维持", "满足"),
            ({"theme_limit_down": 2, "failed_unsealed": False}, "维持", "板块负反馈，信号作废"),
        ]:
            with self.subTest(changes=changes):
                result = reconcile(snapshot({f"{THEME}/000001": facts(**(common | changes))}), prior(candidate()))
                self.assertEqual(result["journal"][0]["action"], direction)
                self.assertEqual(result["journal"][0]["weakToStrong"], weak)

    def test_followers_can_trigger_l3_before_market_leader_breaks(self):
        metrics = facts(followers_limit_down_cluster=True, market_leader_holds=True, failed_unsealed=False)
        result = reconcile(snapshot({f"{THEME}/000001": metrics}), prior(candidate()))
        self.assertEqual(result["alerts"][0]["level"], "L3")
        self.assertEqual(result["alerts"][0]["reason"], "补涨先退潮")

    def test_new_candidate_waits_for_the_next_day_and_starts_low(self):
        new = candidate("000002") | {"reason": "逆势卡位", "admitWhen": [
            condition("promoted", "==", True), condition("boards", ">=", 3)]}
        metrics = facts(promoted=True, boards=3, first_seal_minute=580, breaks=0, failed_unsealed=False)
        data = {f"{THEME}/000002": metrics}
        observed = reconcile(snapshot(data, proposals=[new]), prior(candidate()))
        self.assertEqual(observed["observations"][0]["verification"], "次日验证")
        result = reconcile(snapshot(data), prior(candidate(), observations=[new]))
        admitted = result["candidates"][1]
        self.assertEqual((admitted["code"], admitted["confidence"], admitted["weight"]), ("000002", "低", 1))

    def test_rejects_stale_prior_and_future_evidence(self):
        with self.assertRaisesRegex(ValueError, "上一交易日"):
            reconcile(snapshot(previousDate="2026-11-16"), prior(candidate()))
        metrics = facts(theme_limit_down=2)
        metrics["theme_limit_down"]["observedAt"] = TODAY + "T16:00:00+08:00"
        with self.assertRaisesRegex(ValueError, "晚于截止时间"):
            reconcile(snapshot({f"{THEME}/000001": metrics}), prior(candidate()))

    def test_cli_can_chain_a_baseline_into_next_day_close(self):
        script = Path(__file__).with_name("track.py")
        with TemporaryDirectory() as folder:
            baseline_file = Path(folder, "baseline.json")
            prior_file = Path(folder, "prior.json")
            next_file = Path(folder, "next.json")
            baseline_file.write_text(json.dumps({"date": YESTERDAY, "asOf": YESTERDAY + "T16:10:00+08:00",
                                                "mode": "close", "facts": {}, "candidates": [candidate()]}), encoding="utf-8")
            first = subprocess.run([sys.executable, script, baseline_file, "--baseline"], check=True, capture_output=True)
            first_report = json.loads(first.stdout)
            self.assertEqual(first_report["journal"][0]["action"], "建立基线")
            prior_file.write_bytes(first.stdout)
            next_file.write_text(json.dumps(snapshot({f"{THEME}/000001": facts(theme_limit_down=2, failed_unsealed=True)})), encoding="utf-8")
            today = subprocess.run([sys.executable, script, next_file, "--previous", prior_file], check=True, capture_output=True)
            today_report = json.loads(today.stdout)
            self.assertFalse(today_report["candidates"])
            self.assertEqual(today_report["alerts"][0]["level"], "L3")

    def test_close_demotion_replaces_the_invalidated_role_and_old_condition(self):
        old = candidate()
        next_rule = {"label": "放量破位", "action": "撤销", "all": [condition("capacity_breakdown", "==", True)]}
        old["falsifiers"][0].update(action="降级", toRole="次龙/卡位候选", afterFalsifiers=[next_rule])
        result = reconcile(snapshot({f"{THEME}/000001": facts(theme_limit_down=2, failed_unsealed=True)}), prior(old))
        self.assertEqual(result["journal"][0]["action"], "降级")
        self.assertEqual(result["candidates"][0]["falsifiers"], [next_rule])
        self.assertEqual(result["candidates"][0]["role"], "次龙/卡位候选")

    def test_publishing_is_idempotent_and_refuses_intraday_or_overwrite(self):
        report = reconcile(snapshot(candidates=[candidate()]), None, baseline=True)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "exports").mkdir()
            publish_hanai(root, report)
            publish_hanai(root, report)
            target = root / "exports" / "leader-evolution" / (TODAY + ".json")
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), report)
            with self.assertRaisesRegex(ValueError, "同日已有"):
                publish_hanai(root, report | {"journal": []})
            with self.assertRaisesRegex(ValueError, "盘中结果"):
                publish_hanai(root, report | {"mode": "intraday"})


if __name__ == "__main__":
    unittest.main()
