"""Token-contract fields: daily_logs.workout_status + profile weekly targets.

Revision ID: 0007
Revises: 0006
Create Date: 2026-06-19

Additive, dialect-portable.

- daily_logs.workout_status — nullable "trained"|"rest"|"skipped". Makes the
  §6.5 rest-vs-skip distinction explicit (1.0 / 0.5 / 0.0); null falls back to
  the frequency_days derivation. training_done stays the canonical bool.
- users.weekly_workout_target / weekly_rest_target — nullable smallints (0–7).
  The weekly token quota; null = unset → the client uses its 4/3 default.

Mirrors supabase/migrations/0007_token_contract.sql. Wrapped in
``batch_alter_table`` so SQLite adds the columns + checks via table-copy.
"""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("daily_logs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("workout_status", sa.String(length=20), nullable=True))
        batch_op.create_check_constraint(
            "ck_daily_workout_status",
            "workout_status IS NULL OR workout_status IN ('trained', 'rest', 'skipped')",
        )
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("weekly_workout_target", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("weekly_rest_target", sa.Integer(), nullable=True))
        batch_op.create_check_constraint(
            "ck_users_workout_target",
            "weekly_workout_target IS NULL OR weekly_workout_target BETWEEN 0 AND 7",
        )
        batch_op.create_check_constraint(
            "ck_users_rest_target",
            "weekly_rest_target IS NULL OR weekly_rest_target BETWEEN 0 AND 7",
        )


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_constraint("ck_users_rest_target", type_="check")
        batch_op.drop_constraint("ck_users_workout_target", type_="check")
        batch_op.drop_column("weekly_rest_target")
        batch_op.drop_column("weekly_workout_target")
    with op.batch_alter_table("daily_logs", schema=None) as batch_op:
        batch_op.drop_constraint("ck_daily_workout_status", type_="check")
        batch_op.drop_column("workout_status")
