import { SampleRates } from '../types';
import { REPLAY_SESSION_KEY } from './constants';
import { Session } from './Session';

/**
 * Fetches a session from storage
 */
export function fetchSession({ sessionSampleRate, errorSampleRate }: SampleRates): Session | null {
  const hasSessionStorage = 'sessionStorage' in window;

  if (!hasSessionStorage) {
    return null;
  }

  try {
    // This can throw if cookies are disabled
    const sessionStringFromStorage = window.sessionStorage.getItem(REPLAY_SESSION_KEY);

    if (!sessionStringFromStorage) {
      return null;
    }

    const sessionObj = JSON.parse(sessionStringFromStorage);

    return new Session(sessionObj, { sessionSampleRate, errorSampleRate });
  } catch {
    return null;
  }
}
