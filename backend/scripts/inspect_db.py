"""Ad-hoc schema inspector for migration verification."""
import sqlite3
import sys

db = sys.argv[1] if len(sys.argv) > 1 else "vivid_dev.db"
con = sqlite3.connect(db)
tables = [r[0] for r in con.execute(
    "select name from sqlite_master where type='table' order by name"
)]
print("TABLES:", tables)
print("NON_ALEMBIC_COUNT:", len([t for t in tables if t != "alembic_version"]))
ver = list(con.execute("select version_num from alembic_version"))
print("ALEMBIC_VERSION:", ver)
