"""Create documents, operations and snapshots (docs/05-DATABASE.md).

Revision ID: 0001
Revises:
Create Date: 2026-11-23
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "documents",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False, server_default="Untitled"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("last_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "last_activity",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_table(
        "operations",
        sa.Column(
            "doc_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("seq", sa.BigInteger(), nullable=False, autoincrement=False),
        sa.Column("op_replica", sa.String(128), nullable=False),
        sa.Column("op_counter", sa.BigInteger(), nullable=False),
        sa.Column("payload", JSON_TYPE, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("doc_id", "seq"),
        sa.UniqueConstraint("doc_id", "op_replica", "op_counter", name="uq_operations_dedup"),
    )
    op.create_index("operations_doc_seq_idx", "operations", ["doc_id", "seq"])
    op.create_table(
        "snapshots",
        sa.Column(
            "doc_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("up_to_seq", sa.BigInteger(), nullable=False, autoincrement=False),
        sa.Column("state", JSON_TYPE, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("doc_id", "up_to_seq"),
    )


def downgrade() -> None:
    op.drop_table("snapshots")
    op.drop_index("operations_doc_seq_idx", table_name="operations")
    op.drop_table("operations")
    op.drop_table("documents")
