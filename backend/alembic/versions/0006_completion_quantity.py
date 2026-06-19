"""Add habit_completions.quantity (per-session numeric volume).

Revision ID: 0006
Revises: 0005
Create Date: 2026-06-19

Additive, dialect-portable. The Evening Log wizard logs an optional per-session
quantity for numeric habits (e.g. miles, pages) alongside the done/not-done
completion. Nullable (binary habits / unsupplied → null) with a >= 0 check.
Display-only metadata — scoring still counts logged sessions (§6.7). Mirrors
supabase/migrations/0006_completion_quantity.sql.

Wrapped in ``batch_alter_table`` so SQLite can add the column + check via the
table-copy strategy.
"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("habit_completions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("quantity", sa.Float(), nullable=True))
        batch_op.create_check_constraint(
            "ck_completion_quantity", "quantity IS NULL OR quantity >= 0"
        )


def downgrade() -> None:
    with op.batch_alter_table("habit_completions", schema=None) as batch_op:
        batch_op.drop_constraint("ck_completion_quantity", type_="check")
        batch_op.drop_column("quantity")
