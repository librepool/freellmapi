// Migration: graded health score on model_probe_status (Phase B live-signal
// routing, design note §4).
// Created: 2026-11-11
//
// DOWN: reversible (DROP COLUMN x3).
//
// PR 1 (#1438) stored only a binary verdict ('working' | 'unavailable').
// Phase B grades it: health_score is the exponentially-decayed blend of probe
// outcomes (1 = fast + working, 0 = unavailable; see computeHealthScore in
// services/model-probe.ts), health_samples counts the scored observations,
// health_updated_at stamps the last scoring write. NULL score = never scored.
// An inconclusive ('error') probe never touches any of the three columns.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'model_probe_status', 'health_score')) {
    db.prepare('ALTER TABLE model_probe_status ADD COLUMN health_score REAL').run();
  }
  if (!hasColumn(db, 'model_probe_status', 'health_samples')) {
    db.prepare('ALTER TABLE model_probe_status ADD COLUMN health_samples INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!hasColumn(db, 'model_probe_status', 'health_updated_at')) {
    db.prepare('ALTER TABLE model_probe_status ADD COLUMN health_updated_at TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'model_probe_status', 'health_score')) {
    db.prepare('ALTER TABLE model_probe_status DROP COLUMN health_score').run();
  }
  if (hasColumn(db, 'model_probe_status', 'health_samples')) {
    db.prepare('ALTER TABLE model_probe_status DROP COLUMN health_samples').run();
  }
  if (hasColumn(db, 'model_probe_status', 'health_updated_at')) {
    db.prepare('ALTER TABLE model_probe_status DROP COLUMN health_updated_at').run();
  }
}
