import { describe, it, expect } from 'vitest';
import {
  resolveVoiceIdentity,
  buildAnswerTwiml,
  buildVoicemailTwiml,
} from './twilio-answer';

describe('resolveVoiceIdentity', () => {
  it('namespaces the identity by company', () => {
    expect(resolveVoiceIdentity('acme')).toBe('voice:acme');
  });
});

describe('buildAnswerTwiml', () => {
  const xml = buildAnswerTwiml({
    companyId: 'acme',
    toNumber: '+16504204082',
    origin: 'https://proxy.example.com',
  });

  it('starts real-time transcription with the ?to= query param on the callback', () => {
    expect(xml).toContain('<Start>');
    expect(xml).toContain('<Transcription');
    expect(xml).toContain(
      'statusCallbackUrl="https://proxy.example.com/api/webhooks/twilio/transcription/acme?to=%2B16504204082"',
    );
    expect(xml).toContain('track="both_tracks"');
  });

  it('dials the company client with answerOnBridge and a dial-result action', () => {
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain(
      'action="https://proxy.example.com/api/webhooks/twilio/voice/acme?stage=dial-result"',
    );
    expect(xml).toContain('<Client>voice:acme</Client>');
  });
});

describe('buildVoicemailTwiml', () => {
  it('says a message and hangs up (no dial fallthrough)', () => {
    const xml = buildVoicemailTwiml();
    expect(xml).toContain('<Say');
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });
});
