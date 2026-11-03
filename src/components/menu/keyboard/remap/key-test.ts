import type { KeyTrace } from '@/jotai/keyboard';
import { isModifier } from '@/libs/keyboard/keymap.ts';

/**
 * Pure formatting helpers of the Key test line (spec §3.6): host event,
 * HID codes sent and the resulting report; plus the A1 counter predicate.
 */
const NONE = '–';

/** ⌘⌃⌥⇧ flags of the host event, in that order; '–' when none is held. */
export function formatMods(mods: KeyTrace['ev']['mods']): string {
  if (!mods) return NONE;
  const flags = [mods.meta && '⌘', mods.ctrl && '⌃', mods.alt && '⌥', mods.shift && '⇧'].filter(
    Boolean
  );
  return flags.length > 0 ? flags.join('') : NONE;
}

/** `type · code · key · repeat · mods` for keydown/keyup, shorter for timer / release-all. */
export function formatTraceEvent(trace: KeyTrace): string {
  const ev = trace.ev;
  switch (ev.type) {
    case 'keydown':
      return [
        ev.repeat ? 'keydown (repeat)' : 'keydown',
        ev.code ?? '',
        ev.key ?? '',
        formatMods(ev.mods)
      ].join(' · ');
    case 'keyup':
      return ['keyup', ev.code ?? '', formatMods(ev.mods)].join(' · ');
    case 'timer':
      return ['timer', ev.code ?? ''].join(' · ');
    default:
      return 'release-all';
  }
}

/** '+ControlLeft -KeyC' (press/release/reset entries) or '–' when nothing changed on the wire. */
export function formatTraceSent(trace: KeyTrace): string {
  return trace.sent.length > 0 ? trace.sent.join(' ') : NONE;
}

/** Report bytes as two-digit hex ('01 00 06 00 00 00 00 00'); empty when absent. */
export function formatReport(report: number[] | undefined): string {
  if (!report) return '';
  return report.map((byte) => (byte & 0xff).toString(16).padStart(2, '0')).join(' ');
}

/**
 * A keyup of a non-modifier while ⌘ is held. Assumption A1 says macOS Chrome
 * never delivers one, so the Key test counts them to validate it.
 */
export function isKeyupUnderMeta(trace: KeyTrace): boolean {
  const ev = trace.ev;
  return ev.type === 'keyup' && !!ev.mods?.meta && !!ev.code && !isModifier(ev.code);
}
