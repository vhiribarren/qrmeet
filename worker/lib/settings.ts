/**
 * MIT License
 *
 * Copyright (c) 2026 Vincent Hiribarren
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { Env } from './types'

/**
 * All configurable per-room settings.
 * Stored as a JSON blob in rooms.settings. Adding a new setting requires only:
 *  1. Adding the field here with a default value in parseSettings()
 *  2. Handling it in the admin GET/PUT routes
 * No migration needed.
 */
export interface RoomSettings {
  isOpen: boolean
  scanningEnabled: boolean                  // false = game paused, all scans blocked
  questionsEnabled: boolean
  encounterDurationSeconds: number | null  // null = use server default
  maxParticipants: number | null           // null = use server default
  treasureHuntEnabled: boolean             // treasure hunt mode on/off
  treasureDefaultPoints: number            // points for treasures with no override
}

export function parseSettings(raw: string | null | undefined): RoomSettings {
  let s: Partial<RoomSettings> = {}
  try { s = JSON.parse(raw || '{}') } catch {}
  return {
    isOpen:                   s.isOpen                   ?? true,
    scanningEnabled:          s.scanningEnabled          ?? true,
    questionsEnabled:         s.questionsEnabled         ?? true,
    encounterDurationSeconds: s.encounterDurationSeconds ?? null,
    maxParticipants:          s.maxParticipants          ?? null,
    treasureHuntEnabled:      s.treasureHuntEnabled      ?? false,
    treasureDefaultPoints:    s.treasureDefaultPoints    ?? 3,
  }
}

export function resolveSettings(settings: RoomSettings, env: Env) {
  return {
    isOpen:                   settings.isOpen,
    scanningEnabled:          settings.scanningEnabled,
    questionsEnabled:         settings.questionsEnabled,
    encounterDurationSeconds: settings.encounterDurationSeconds
                                ?? parseInt(env.ENCOUNTER_DURATION_SECONDS || '300'),
    maxParticipants:          settings.maxParticipants
                                ?? parseInt(env.MAX_PARTICIPANTS || '100'),
    treasureHuntEnabled:      settings.treasureHuntEnabled,
    treasureDefaultPoints:    settings.treasureDefaultPoints,
  }
}
