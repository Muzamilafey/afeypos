import { TERMINAL_PROVIDER_INFO, type TerminalAvailability, type TerminalProviderKey } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { unprocessable } from '../../lib/errors.js';
import type { TerminalAdapter } from './adapter.js';
import { SimulatorTerminalAdapter } from './simulator.js';

/**
 * Implemented adapters. A provider gets an entry here only when its adapter is built from the provider's
 * official documentation; Equity Bank and the other banks have none yet (see TERMINAL_PROVIDER_INFO).
 */
const ADAPTERS: Partial<Record<TerminalProviderKey, () => TerminalAdapter>> = {
  simulator: () => new SimulatorTerminalAdapter(),
};

/** The simulator is for training and tests: always outside production, in production only when switched on. */
export const simulatorAllowed = () => env().NODE_ENV !== 'production' || env().TERMINAL_SIMULATOR;

/** Availability on this installation (the simulator is hidden where it is not allowed). */
export function providerAvailability(key: TerminalProviderKey): TerminalAvailability | 'disabled_here' {
  const info = TERMINAL_PROVIDER_INFO[key];
  if (key === 'simulator' && !simulatorAllowed()) return 'disabled_here';
  if ((info.availability === 'available' || info.availability === 'sandbox') && !ADAPTERS[key]) return 'not_supported';
  return info.availability;
}

export function adapterFor(provider: string): TerminalAdapter {
  const key = provider as TerminalProviderKey;
  const info = TERMINAL_PROVIDER_INFO[key];
  if (!info) throw unprocessable('Unknown card terminal provider', 'TERMINAL_PROVIDER_UNKNOWN');
  const a = providerAvailability(key);
  if (a === 'disabled_here') throw unprocessable('The terminal simulator is turned off on this installation (TERMINAL_SIMULATOR)', 'TERMINAL_PROVIDER_UNAVAILABLE');
  if (a === 'provider_access_required') throw unprocessable(`${info.label} is not supported yet: provider access is required`, 'TERMINAL_PROVIDER_ACCESS_REQUIRED');
  if (a === 'not_supported') throw unprocessable(`${info.label} is not yet supported`, 'TERMINAL_PROVIDER_NOT_SUPPORTED');
  return ADAPTERS[key]!();
}
