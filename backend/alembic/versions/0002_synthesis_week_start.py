"""Add week_start to ai_syntheses for per-ISO-week synthesis idempotency.

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-17

Additive, dialect-portable. Adds the NOT NULL ``week_start`` column plus the
``uq_synthesis_user_type_week`` unique constraint that makes weekly synthesis
idempotent per (user_id, type, week_start) — see CLAUDE.md §6 step 10.

SQLite can't ALTER to a NOT NULL column or add a table-level constraint in
place, so both changes run inside a single ``batch_alter_table`` block (one
table rebuild). The column carries a harmless ISO-Monday server_default
('1970-01-05', isodow=1) only to backfill any pre-existing rows; the ORM always
supplies a real value on insert. Mirrors supabase/migrations/0002_*.sql.
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("ai_syntheses", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "week_start",
                sa.Date(),
                nullable=False,
                server_default="1970-01-05",  # ISO Monday; backfill-only
            )
        )
        batch_op.create_unique_constraint(
            "uq_synthesis_user_type_week", ["user_id", "type", "week_start"]
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_syntheses", schema=None) as batch_op:
        batch_op.drop_constraint("uq_synthesis_user_type_week", type_="unique")
        batch_op.drop_column("week_start")
