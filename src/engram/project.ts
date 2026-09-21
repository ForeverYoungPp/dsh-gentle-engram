/**
 * Project resolution and the fail-closed write gate.
 *
 * Engram refuses to guess: `POST /sessions` requires an explicit project, and
 * the first-party clients all treat a soft "ambiguous" envelope as a failure.
 * So a workspace that contains several repositories simply cannot receive
 * memory until the user disambiguates — and this module's job is to make that
 * state loud instead of silently writing to the wrong project.
 *
 * @module dsh-gentle-engram/engram/project
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { EngramClient } from './client.ts'
import { EngramHttpError } from './errors.ts'

/** Engram's `GET /project/current` envelope. */
export interface ProjectEnvelope {
  readonly project?: unknown
  readonly project_source?: unknown
  readonly project_path?: unknown
  readonly cwd?: unknown
  readonly available_projects?: unknown
  readonly warning?: unknown
  readonly error_hint?: unknown
}

/** Resolution state for one session's workspace. */
export type ProjectResolution =
  | { readonly kind: 'resolved'; readonly project: string; readonly source: string }
  | { readonly kind: 'pending'; readonly reason: string; readonly available: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string; readonly available: readonly string[] }

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Sources the first-party clients accept as proof of a real detection. */
const TRUSTED_SOURCES = new Set([
  'config', 'git_remote', 'git_root', 'git_child', 'dir_basename', 'process_override',
])

/**
 * Accept a detected project only when Engram reports no hint of trouble. A soft
 * 200 carrying `error_hint` is a failure: the first-party clients reject it too.
 */
export function isSafeDetectedProject(envelope: ProjectEnvelope): string | undefined {
  const candidate = asString(envelope.project)
  if (candidate === undefined) return undefined
  if (candidate.toLowerCase() === 'unknown') return undefined
  if (asString(envelope.error_hint) !== undefined) return undefined
  // Reject anything that could be a path or carry control characters: a
  // project key must be a name, not a filesystem location.
  if (/[\\/\u0000-\u001F\u007F]/.test(candidate)) return undefined
  const source = asString(envelope.project_source)
  if (source !== undefined && !TRUSTED_SOURCES.has(source)) return undefined
  return candidate
}

/**
 * Fallback used when a running server predates `GET /project/current`. Walks up
 * from `cwd` looking for `.engram/config.json`, mirroring upstream's graceful
 * degradation for version skew.
 */
export function detectLocalConfigProject(cwd: string): { project: string; path: string } | undefined {
  let current = resolve(cwd || '.')
  for (;;) {
    const configPath = `${current}/.engram/config.json`
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { project_name?: unknown }
        const project = asString(parsed.project_name)
        if (project !== undefined) return { project, path: configPath }
      } catch {
        return undefined
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Lower-cased directory name, used for display only — never for a write. */
export function fallbackProjectName(cwd: string): string {
  return basename(resolve(cwd || '.')).trim().toLowerCase() || 'unknown'
}

/** Human-actionable guidance for an unresolvable workspace. */
export function ambiguityGuidance(available: readonly string[]): string {
  const choices = available.length > 0 ? ` Known projects: ${available.join(', ')}.` : ''
  return 'Engram could not determine which project this workspace belongs to. '
    + 'Add .engram/config.json with {"project_name": "..."} at the repository root, '
    + 'or start DeepSeek Harness inside a single repository.'
    + choices
}

/**
 * Resolve the project for one session workspace.
 *
 * @param client - transport.
 * @param cwd - the session's absolute working directory.
 */
export async function resolveProject(client: EngramClient, cwd: string): Promise<ProjectResolution> {
  const query = `?cwd=${encodeURIComponent(cwd)}`
  let envelope: ProjectEnvelope
  try {
    envelope = await client.request<ProjectEnvelope>(`/project/current${query}`) ?? {}
  } catch (error: unknown) {
    // An older server without the route: degrade to the nearest repo config,
    // exactly as upstream does, rather than failing closed on version skew.
    if (error instanceof EngramHttpError && error.status === 404) {
      const local = detectLocalConfigProject(cwd)
      if (local !== undefined) return { kind: 'resolved', project: local.project, source: 'config' }
      return { kind: 'pending', reason: 'the running Engram server does not expose /project/current', available: [] }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', reason: detail, available: [] }
  }

  const project = isSafeDetectedProject(envelope)
  if (project !== undefined) {
    return { kind: 'resolved', project, source: asString(envelope.project_source) ?? 'unknown' }
  }
  const available = asStringList(envelope.available_projects)
  const hint = asString(envelope.error_hint) ?? asString(envelope.warning)
  if (hint !== undefined || asString(envelope.project) !== undefined) {
    return { kind: 'failed', reason: hint ?? 'Engram reported an unusable project', available }
  }
  return { kind: 'pending', reason: 'Engram did not report a project for this directory', available }
}
