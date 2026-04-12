/**
 * Zod schema for cli-adapters/*.jsonc files.
 *
 * Changes here must be matched in schemas/adapter.schema.json (which drives
 * editor autocomplete for the JSONC files — that's only for DX, this Zod
 * schema is the source of truth for validation).
 */

import { z } from 'zod';

const tmuxKey = z.string().min(1);

const patternSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['ready', 'working', 'prompt_detected', 'task_done', 'error', 'exited']),
  regex: z.string().min(1),
  flags: z.string().optional(),
  scope: z.enum(['tail', 'tail_line']).default('tail'),
  choices: z.array(z.string()).optional(),
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  description: z.string().optional()
});

export type AdapterPatternConfig = z.infer<typeof patternSchema>;

/**
 * How the hub should capture the reconnect snapshot for agents of this kind.
 *
 * - `'visible'` — capture only what's on the pane right now (`capture-pane -S 0`).
 *   Correct for TUI CLIs that repaint their whole UI in the main buffer (Claude
 *   Code, Codex, Gemini). Tmux scrollback for those CLIs is a stack of redraw
 *   ghosts — including byte-unequal variants produced by things like Claude
 *   Code's Ctrl-O expand/collapse widget — that no dedup heuristic can fully
 *   clean up, so we just drop it on reopen.
 *
 * - `'history'` — capture `-S -500` and pipe through `collapseRepeatingTailBlocks`.
 *   Correct for line-based CLIs (shells, REPLs) where real backlog is what the
 *   user wants to see when they reopen the modal, and where scrollback doesn't
 *   contain full-UI redraws.
 */
export const scrollbackModeEnum = z.enum(['visible', 'history']);
export type ScrollbackMode = z.infer<typeof scrollbackModeEnum>;

export const adapterConfigSchema = z.object({
  $schema: z.string().optional(),
  kind: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * Reconnect-snapshot capture mode. Defaults to `'visible'` because most
   * agents in MAW are ink/react-style TUI CLIs; explicit `'history'` is only
   * right for line-based CLIs like the shell smoke adapter.
   */
  scrollbackMode: scrollbackModeEnum.default('visible'),

  spawn: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    initialInput: z.string().optional()
  }),

  input: z.object({
    encoding: z.enum(['literal']).default('literal'),
    submitKey: tmuxKey.default('Enter'),
    promptAnswers: z.record(z.string(), z.array(tmuxKey)).default({})
  }),

  patterns: z.array(patternSchema).default([]),

  idleDetection: z
    .object({
      method: z.enum(['cursor_at_prompt', 'inactivity']).default('inactivity'),
      promptLineRegex: z.string().optional(),
      inactivityMs: z.number().int().positive().default(2000)
    })
    .default({
      method: 'inactivity',
      promptLineRegex: undefined,
      inactivityMs: 2000
    }),

  defaults: z
    .object({
      autoAnswer: z
        .array(
          z.object({
            patternId: z.string(),
            when: z.record(z.string(), z.string()).optional(),
            answer: z.string()
          })
        )
        .default([])
    })
    .default({ autoAnswer: [] })
});

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;
