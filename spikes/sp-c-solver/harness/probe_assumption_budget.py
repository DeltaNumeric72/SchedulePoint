"""H-8 follow-up: how long does the capacity infeasibility take WITH assumptions?

Not part of the standard harness run (it burns 90s answering a question the
harness already answers directionally at 20s). Kept so the number in
SPIKE-REPORT.md is reproducible.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from harness import driver  # noqa: E402


def main() -> int:
    problem = driver.load_problem("toy-infeasible-capacity")
    for granularity, budget in (("rule", 90.0), ("instance", 90.0)):
        result = driver.run_solve(
            driver.build_request(
                problem,
                {"max_time_in_seconds": budget, "num_search_workers": 8},
                explanation={
                    "use_assumptions": True,
                    "assumption_granularity": granularity,
                },
                correlation_id="probe-%s" % granularity,
            ),
            timeout_seconds=budget + 120,
        )
        response = result.response
        sa = response["sufficient_assumptions"]
        print(
            "granularity=%-9s budget=%.0fs -> status=%-10s wall=%.3fs "
            "assumptions=%d core=%d"
            % (
                granularity,
                budget,
                response["status"],
                response["reproducibility"]["solve_wall_seconds"],
                sa["assumption_count_total"],
                sa["count"],
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
