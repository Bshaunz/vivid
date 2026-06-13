"""Initial schema — 9 tables per CLAUDE.md v4.0 §5.

Revision ID: 0001
Revises:
Create Date: 2026-06-12

Hand-written to mirror app/models.py and the Supabase SQL migration exactly.
String enums (portable to SQLite); native PG enums exist only in the
Supabase launch migration.
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

BASELINE_KEYS = (
    "morning_readiness",
    "sleep_hours",
    "rhr",
    "hrv",
    "deep_work_hours",
    "discretionary_spend",
    "weekly_median_bodyweight",
)


def _enum(*values: str, name: str) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("name", sa.String(80)),
        sa.Column("currency", _enum("CAD", "USD", name="currency_code"),
                  nullable=False, server_default="CAD"),
        sa.Column("unit_pref", _enum("lbs", "kg", name="unit_preference"),
                  nullable=False, server_default="lbs"),
        sa.Column("active_pillars", sa.JSON(), nullable=False),
        sa.Column("daily_budget", sa.Float()),
        sa.Column("bodyweight_goal", sa.Float()),
        sa.Column("consent_timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("daily_budget IS NULL OR daily_budget >= 0",
                           name="ck_users_budget"),
        sa.CheckConstraint("bodyweight_goal IS NULL OR bodyweight_goal BETWEEN 30 AND 660",
                           name="ck_users_bw_goal"),
    )

    op.create_table(
        "daily_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("morning_readiness", sa.Integer()),
        sa.Column("sleep_hours", sa.Float()),
        sa.Column("rhr", sa.Integer()),
        sa.Column("hrv", sa.Integer()),
        sa.Column("morning_done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("training_done", sa.Boolean()),
        sa.Column("workout_rpe", sa.Integer()),
        sa.Column("deep_work_hours", sa.Float()),
        sa.Column("macro_adherence", sa.Boolean()),
        sa.Column("caloric_variance_pct", sa.Float()),
        sa.Column("discretionary_spend", sa.Float()),
        sa.Column("daily_reflection", sa.Text()),
        sa.Column("evening_done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("user_id", "date", name="uq_daily_logs_user_date"),
        sa.CheckConstraint("morning_readiness IS NULL OR morning_readiness BETWEEN 1 AND 10",
                           name="ck_daily_readiness"),
        sa.CheckConstraint("sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 16",
                           name="ck_daily_sleep"),
        sa.CheckConstraint("rhr IS NULL OR rhr BETWEEN 20 AND 250", name="ck_daily_rhr"),
        sa.CheckConstraint("hrv IS NULL OR hrv BETWEEN 0 AND 300", name="ck_daily_hrv"),
        sa.CheckConstraint("workout_rpe IS NULL OR workout_rpe BETWEEN 1 AND 10",
                           name="ck_daily_rpe"),
        sa.CheckConstraint("deep_work_hours IS NULL OR deep_work_hours BETWEEN 0 AND 24",
                           name="ck_daily_deep_work"),
        sa.CheckConstraint(
            "discretionary_spend IS NULL OR "
            "(discretionary_spend >= 0 AND discretionary_spend < 1e9)",
            name="ck_daily_spend"),
        sa.CheckConstraint("daily_reflection IS NULL OR length(daily_reflection) <= 1000",
                           name="ck_daily_reflection_len"),
        sa.CheckConstraint(
            "NOT morning_done OR (morning_readiness IS NOT NULL AND sleep_hours IS NOT NULL)",
            name="ck_daily_morning_complete"),
        sa.CheckConstraint(
            "NOT evening_done OR (training_done IS NOT NULL "
            "AND deep_work_hours IS NOT NULL AND discretionary_spend IS NOT NULL)",
            name="ck_daily_evening_complete"),
    )
    op.create_index("idx_daily_logs_user_date", "daily_logs", ["user_id", "date"])

    op.create_table(
        "bodyweight_entries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("logged_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.CheckConstraint("value BETWEEN 30 AND 660", name="ck_bw_value"),
    )
    op.create_index("idx_bodyweight_user_time", "bodyweight_entries",
                    ["user_id", "logged_at"])

    op.create_table(
        "habits",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("pillar", _enum("Health", "Fitness", "Finances", name="pillar_type")),
        sa.Column("frequency_type", _enum("daily", "weekly", "monthly", name="frequency_type"),
                  nullable=False, server_default="daily"),
        sa.Column("frequency_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("frequency_days", sa.JSON()),
        sa.Column("is_preset", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("frequency_count >= 1", name="ck_habits_freq_count"),
    )
    op.create_index("idx_habits_user_active", "habits", ["user_id", "is_active"])

    op.create_table(
        "habit_completions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("habit_id", sa.Integer(),
                  sa.ForeignKey("habits.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.UniqueConstraint("user_id", "habit_id", "date",
                            name="uq_completion_user_habit_date"),
    )
    op.create_index("idx_habit_completions_user_date", "habit_completions",
                    ["user_id", "date"])

    op.create_table(
        "weekly_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("capital_allocated", sa.Float(), nullable=False),
        sa.Column("bottleneck_audit", sa.Text()),
        sa.UniqueConstraint("user_id", "week_start", name="uq_weekly_logs_user_week"),
        sa.CheckConstraint("capital_allocated >= 0 AND capital_allocated < 1e9",
                           name="ck_weekly_capital"),
        sa.CheckConstraint("bottleneck_audit IS NULL OR length(bottleneck_audit) <= 1000",
                           name="ck_weekly_audit_len"),
    )

    op.create_table(
        "goals",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("type", _enum("metric", "habit", name="goal_type"), nullable=False),
        sa.Column("metric_key", sa.String(64)),
        sa.Column("target_value", sa.Float()),
        sa.Column("direction", _enum("above", "below", name="goal_direction")),
        sa.Column("habit_id", sa.Integer(), sa.ForeignKey("habits.id", ondelete="CASCADE")),
        sa.Column("target_date", sa.Date(), nullable=False),
        sa.Column("pillar", _enum("Health", "Fitness", "Finances", name="pillar_type")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "(type = 'metric' AND metric_key IS NOT NULL "
            "AND target_value IS NOT NULL AND direction IS NOT NULL) "
            "OR (type = 'habit' AND habit_id IS NOT NULL)",
            name="ck_goal_shape"),
    )
    op.create_index("idx_goals_user_active", "goals", ["user_id", "is_active"])

    op.create_table(
        "baselines",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.String(64), nullable=False),
        sa.Column("window_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("mean", sa.Float(), nullable=False),
        sa.Column("sd", sa.Float(), nullable=False),
        sa.Column("n_observations", sa.Integer(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "metric_key", name="uq_baselines_user_metric"),
        sa.CheckConstraint(
            "metric_key IN ({})".format(", ".join(f"'{k}'" for k in BASELINE_KEYS)),
            name="ck_baseline_metric_key"),
        sa.CheckConstraint("sd >= 0", name="ck_baseline_sd"),
        sa.CheckConstraint("n_observations >= 7", name="ck_baseline_n"),
    )

    op.create_table(
        "ai_syntheses",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(36),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("type", _enum("weekly", name="synthesis_type"),
                  nullable=False, server_default="weekly"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        sa.CheckConstraint("tokens_in >= 0 AND tokens_out >= 0", name="ck_synthesis_tokens"),
    )
    op.create_index("idx_ai_syntheses_user_time", "ai_syntheses",
                    ["user_id", "generated_at"])


def downgrade() -> None:
    op.drop_table("ai_syntheses")
    op.drop_table("baselines")
    op.drop_table("goals")
    op.drop_table("weekly_logs")
    op.drop_table("habit_completions")
    op.drop_table("habits")
    op.drop_table("bodyweight_entries")
    op.drop_table("daily_logs")
    op.drop_table("users")
