import os
import tempfile
from pathlib import Path

# The API module builds its store at import time, so the test database has to be
# chosen before anything imports `app.main`.
_TMP = Path(tempfile.mkdtemp(prefix="gantt-tests-"))
os.environ["PLAN_DB_PATH"] = str(_TMP / "plans.sqlite3")
os.environ.setdefault("OPENROUTER_API_KEY", "")
