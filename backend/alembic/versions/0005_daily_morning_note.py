"""Add daily_logs.morning_note (optional free-text morning journal).

Revision ID: 0005
Revises: 0004
Create Date: 2026-06-18

Additive, dialect-portable. The Morning Log wizard's final "Anything else?"
step writes an optional free-text note onto the day row — the morning mirror of
the evening ``daily_reflection``. Nullable (the note is strictly optional) with
a 1000-char check constraint matching daily_reflection. Feeds no score; it is a
journal field only. Mirrors supabase/migrations/0005_daily_morning_note.sql.

Wrapped in ``batch_alter_table`` so the SQLite dev path can add the column and
the check constraint via the table-copy strategy.
"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("daily_logs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("morning_note", sa.Text(), nullable=True))
        batch_op.create_check_constraint(
            "ck_daily_morning_note_len",
            "morning_note IS NULL OR length(morning_note) <= 1000",
        )


def downgrade() -> None:
    with op.batch_alter_table("daily_logs", schema=None) as batch_op:
        batch_op.drop_constraint("ck_daily_morning_note_len", type_="check")
        batch_op.drop_column("morning_note")
