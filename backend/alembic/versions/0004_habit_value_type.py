"""Add numeric-tracking metadata to habits (value_type, unit_label, per-session).

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-18

Additive, dialect-portable. Habits gain a tracking shape:
  - value_type   "binary" (done/not-done, the default) or "numeric"
  - unit_label   free-text unit for numeric habits, e.g. "miles", "pages"
  - target_per_session  default quantity logged per session (numeric only)

value_type is NOT NULL with a "binary" server_default so pre-existing habit rows
backfill cleanly; the API always supplies a value on insert. unit_label and
target_per_session are nullable (only set for numeric habits). Completions stay
done/not-done — this metadata is display-only. Mirrors
supabase/migrations/0004_habit_value_type.sql.

SQLite can't add a NOT NULL column without a default in place, so the
server_default does double duty (backfill + dialect portability). Wrapped in
``batch_alter_table`` for the SQLite dev path.
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("habits", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "value_type",
                sa.String(length=20),
                nullable=False,
                server_default="binary",  # backfill existing rows
            )
        )
        batch_op.add_column(sa.Column("unit_label", sa.String(length=40), nullable=True))
        batch_op.add_column(sa.Column("target_per_session", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("habits", schema=None) as batch_op:
        batch_op.drop_column("target_per_session")
        batch_op.drop_column("unit_label")
        batch_op.drop_column("value_type")
