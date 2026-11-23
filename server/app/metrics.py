"""Prometheus metrics (docs/08-DEPLOYMENT.md section 4). One registry per app."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

LATENCY_BUCKETS = (0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5)


class Metrics:
    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        self.connected_clients = Gauge(
            "collab_connected_clients", "Open WebSocket connections", registry=self.registry
        )
        self.ops_total = Counter(
            "collab_ops_total", "Operations stored (new, not duplicates)", registry=self.registry
        )
        self.duplicate_ops_total = Counter(
            "collab_duplicate_ops_total", "Operations ignored as duplicates", registry=self.registry
        )
        self.batches_total = Counter(
            "collab_batches_total", "Operation batches received", registry=self.registry
        )
        self.errors_total = Counter(
            "collab_errors_total", "Errors sent to clients", ["code"], registry=self.registry
        )
        self.broadcast_seconds = Histogram(
            "collab_broadcast_seconds",
            "Time to queue a stored batch for all local clients",
            buckets=LATENCY_BUCKETS,
            registry=self.registry,
        )
        self.db_write_seconds = Histogram(
            "collab_db_write_seconds",
            "Time to store one batch in the database",
            buckets=LATENCY_BUCKETS,
            registry=self.registry,
        )
        self.dropped_clients_total = Counter(
            "collab_dropped_slow_clients_total",
            "Clients dropped because their send queue filled up",
            registry=self.registry,
        )

    def render(self) -> bytes:
        return generate_latest(self.registry)
