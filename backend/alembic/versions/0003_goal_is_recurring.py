"""Add is_recurring to goals (one-off "this period" vs recurring "every period").

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-18

Additive, dialect-portable. Adds the NOT NULL boolean ``is_recurring`` with a
``false`` server_default so pre-existing goal rows backfill cleanly; the API
always supplies a value on insert. Goals remain DISPLAY-ONLY (§6.7) — this flag
feeds no score. Mirrors supabase/migrations/0003_goal_is_recurring.sql.

SQLite can't add a NOT NULL column without a default in place, so the
server_default does double duty (backfill + dialect portability). Wrapped in
``batch_alter_table`` for the SQLite dev path.
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("goals", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "is_recurring",
                sa.Boolean(),
                nullable=False,
                server_default="0",  # false; backfill-only
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("goals", schema=None) as batch_op:
        batch_op.drop_column("is_recurring")
