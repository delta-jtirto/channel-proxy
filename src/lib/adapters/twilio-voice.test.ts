import { describe, it, expect } from 'vitest';
import {
  mapTwilioCallStatus,
  formatCallDurationMirror,
  formatCallPreviewMirror,
  resolveCallerContactId,
  recordingStoragePath,
  callIdempotencyKey,
} from './twilio-voice';

describe('mapTwilioCallStatus', () => {
  it('maps queued/ringing/in-progress to our in-progress (no ringing-vs-answered distinction, matches formatCallPreview)', () => {
    expect(mapTwilioCallStatus('queued', null)).toBe('in-progress');
    expect(mapTwilioCallStatus('ringing', null)).toBe('in-progress');
    expect(mapTwilioCallStatus('in-progress', null)).toBe('in-progress');
  });
  it('maps completed with a positive duration to completed', () => {
    expect(mapTwilioCallStatus('completed', 252)).toBe('completed');
  });
  it('maps completed with zero/null duration to missed (never actually connected)', () => {
    expect(mapTwilioCallStatus('completed', 0)).toBe('missed');
    expect(mapTwilioCallStatus('completed', null)).toBe('missed');
  });
  it('maps no-answer to missed', () => {
    expect(mapTwilioCallStatus('no-answer', null)).toBe('missed');
  });
  it('maps busy/failed/canceled to failed', () => {
    expect(mapTwilioCallStatus('busy', null)).toBe('failed');
    expect(mapTwilioCallStatus('failed', null)).toBe('failed');
    expect(mapTwilioCallStatus('canceled', null)).toBe('failed');
  });
});

describe('formatCallDurationMirror (must match src/core/voice/format.ts formatCallDuration byte-for-byte)', () => {
  it('formats sub-minute, minute, and hour durations', () => {
    expect(formatCallDurationMirror(45)).toBe('45s');
    expect(formatCallDurationMirror(252)).toBe('4m 12s');
    expect(formatCallDurationMirror(120)).toBe('2m');
    expect(formatCallDurationMirror(3661)).toBe('1h 1m');
  });
});

describe('formatCallPreviewMirror (must match src/core/voice/format.ts formatCallPreview byte-for-byte)', () => {
  it('labels in-progress, missed, and completed-with-duration calls', () => {
    expect(formatCallPreviewMirror('in-progress', null)).toBe('Call in progress…');
    expect(formatCallPreviewMirror('missed', null)).toBe('Missed call');
    expect(formatCallPreviewMirror('failed', null)).toBe('Failed call');
    expect(formatCallPreviewMirror('completed', 252)).toBe('Inbound call · 4m 12s');
  });
});

describe('resolveCallerContactId', () => {
  it('returns the E.164 From number verbatim for a normal caller', () => {
    expect(resolveCallerContactId('+16505551234', 'CAxxxx')).toBe('+16505551234');
  });
  it('falls back to a CallSid-scoped synthetic id for blocked caller ID, so distinct blocked callers do not collapse into one contact', () => {
    expect(resolveCallerContactId('anonymous', 'CAxxxx')).toBe('blocked:CAxxxx');
    expect(resolveCallerContactId('restricted', 'CAyyyy')).toBe('blocked:CAyyyy');
    expect(resolveCallerContactId('', 'CAzzzz')).toBe('blocked:CAzzzz');
  });
});

describe('recordingStoragePath', () => {
  it('builds a company-scoped storage object path', () => {
    expect(recordingStoragePath('acme-corp', 'CAxxxx')).toBe('acme-corp/CAxxxx.mp3');
  });
});

describe('callIdempotencyKey', () => {
  it('prefixes the CallSid so it cannot collide with chat idempotency_keys', () => {
    expect(callIdempotencyKey('CAxxxx')).toBe('voice_CAxxxx');
  });
});
