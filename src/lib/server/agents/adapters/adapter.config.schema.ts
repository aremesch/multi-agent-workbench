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
 * One on-screen key-chord button shown to mobile users under xterm. Phone soft
 * keyboards don't surface arrow keys / Esc / Shift+Tab / Ctrl+C, which most
 * coding-agent TUIs need constantly — `mobileQuickKeys` lets each adapter
 * declare its own tailored quick-key row. The string in `keys` is forwarded
 * verbatim through the existing `send_keys` WS path (same encoding as bytes
 * coming out of xterm's `onData`), so values are raw UTF-8 — typically VT
 * escape sequences like `"\u001b[A"` for cursor up.
 */
export const mobileQuickKeySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id must match /^[a-z0-9-]+$/'),
  label: z.string().min(1),
  keys: z.string().min(1)
});
export type MobileQuickKeyConfig = z.infer<typeof mobileQuickKeySchema>;

export const adapterConfigSchema = z.object({
  $schema: z.string().optional(),
  kind: z.string().min(1),
  displayName: z.string().min(1),

  /**
   * Whether spawning an agent of this kind should create a dedicated git
   * worktree under <worktreeRoot>/<agentId>. Defaults to true — what every
   * real coding-agent CLI wants. Set to false for adapters that should run
   * directly in the repo root on whatever branch is already checked out
   * (e.g. the shell smoke adapter).
   */
  createWorktree: z.boolean().default(true),

  /**
   * On-screen key-chord buttons rendered under xterm on touch devices (or
   * whenever the user toggles `ui.mobileQuickKeys` to `"always"`). Empty by
   * default — an adapter opts in by listing keys. `id` must be unique within
   * the adapter; `keys` is raw UTF-8 forwarded verbatim via `send_keys`.
   */
  mobileQuickKeys: z
    .array(mobileQuickKeySchema)
    .default([])
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i]!.id;
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'id'],
            message: `duplicate mobileQuickKeys id '${id}' within adapter`
          });
        }
        seen.add(id);
      }
    }),

  spawn: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    optionalArgs: z
      .array(
        z.object({
          id: z.string().min(1),
          flag: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
          default: z.boolean().default(false)
        })
      )
      .default([]),
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
