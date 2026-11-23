"""Workspaces: projects, files (extra columns on documents) and activity.

Additive only: existing standalone documents keep working (project_id is NULL).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-23
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, server_default="Untitled project"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    with op.batch_alter_table("documents") as batch:
        batch.add_column(sa.Column("project_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("name", sa.Text(), nullable=True))
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("seed_text", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("seed_claimed", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.create_foreign_key(
            "fk_documents_project", "projects", ["project_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_index("ix_documents_project_id", ["project_id"])
    op.create_table(
        "activity",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            primary_key=True,
            autoincrement=True,
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=True),
        sa.Column("file_name", sa.Text(), nullable=True),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_activity_project_id", "activity", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_project_id", table_name="activity")
    op.drop_table("activity")
    with op.batch_alter_table("documents") as batch:
        batch.drop_index("ix_documents_project_id")
        batch.drop_constraint("fk_documents_project", type_="foreignkey")
        for col in ("seed_claimed", "seed_text", "deleted_at", "name", "project_id"):
            batch.drop_column(col)
    op.drop_table("projects")
