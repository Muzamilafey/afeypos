import { useEffect, useRef, useState } from 'react';
import { readingProblem, weighedAmountCents, type ScaleReading } from '@afeypos/shared';
import { parseTypedWeight, readBridgeScale, tareBridgeScale } from '../lib/scale';
import { money } from '../lib/format';
import { Button, Input, Modal } from './ui';

export function ReadingView({ reading }: { reading: ScaleReading }) {
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-ink-50 p-3 text-center dark:bg-ink-900" data-testid="scale-reading">
      <div><div className="text-xs text-ink-500">Gross</div><div className="font-mono text-lg">{reading.grossKg.toFixed(3)}</div></div>
      <div><div className="text-xs text-ink-500">Tare</div><div className="font-mono text-lg">{reading.tareKg.toFixed(3)}</div></div>
      <div><div className="text-xs text-ink-500">Net kg</div><div className="font-mono text-2xl font-semibold">{reading.netKg.toFixed(3)}</div></div>
      <div className="col-span-3 text-xs">{reading.stable ? <span className="text-emerald-700">Stable</span> : <span className="text-amber-700">Settling…</span>}{reading.raw ? <span className="ml-2 font-mono text-ink-400">{reading.raw}</span> : null}</div>
    </div>
  );
}

/**
 * Weighs a product at the till. Only a stable, positive net weight can be added. Bridge scales are read every
 * 400 ms; keyboard scales type the weight into the box. Price shown is an estimate: the server prices the line.
 */
export function WeighModal({ scale, product, pricePerKgCents, onAdd, onClose }: {
  scale: { name: string; adapter: string; settings?: { minKg?: number; maxKg?: number } };
  product: { name: string; baseUnit: string };
  pricePerKgCents?: number;
  onAdd: (netKg: number) => void;
  onClose: () => void;
}) {
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const bridgeMode = scale.adapter === 'bridge-serial';
  const latest = useRef<ScaleReading | null>(null);
  latest.current = reading;

  useEffect(() => {
    if (!bridgeMode) return;
    const ctrl = new AbortController();
    let stop = false;
    const loop = async () => {
      while (!stop) {
        try {
          const r = await readBridgeScale(ctrl.signal);
          if (!stop) { setReading(r); setError(null); }
        } catch (e) {
          if (!stop) setError((e as Error).message);
        }
        await new Promise((res) => setTimeout(res, 400));
      }
    };
    loop();
    return () => { stop = true; ctrl.abort(); };
  }, [bridgeMode]);

  const problem = reading ? readingProblem(reading, scale.settings ?? {}) : 'Place the item on the scale';
  const add = () => {
    const r = latest.current;
    if (r && !readingProblem(r, scale.settings ?? {})) onAdd(r.netKg);
  };
  useEffect(() => {
    if (!bridgeMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <Modal open onClose={onClose} title={`Weigh ${product.name}`} subtitle={`On ${scale.name}`} icon="activity" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={Boolean(problem)} onClick={add}>Add {reading && !problem ? `${reading.netKg.toFixed(3)} kg` : ''}</Button></>}>
      {!bridgeMode && (
        <Input autoFocus aria-label="Weight from the scale" placeholder="Press the scale's send key" value={typed}
          onChange={(e) => { setTyped(e.target.value); setReading(parseTypedWeight(e.target.value)); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      )}
      {reading && <ReadingView reading={reading} />}
      {pricePerKgCents && reading && !problem ? <div className="mt-2 text-center text-sm text-ink-600">About {money(weighedAmountCents(pricePerKgCents, reading.netKg))} at {money(pricePerKgCents)}/kg</div> : null}
      {problem && <div className="mt-2 text-center text-sm text-amber-700" data-testid="weigh-problem">{problem}</div>}
      {error && <div className="mt-2 text-center text-sm text-red-600">{error}</div>}
      {bridgeMode && (
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => tareBridgeScale().catch((e) => setError(e.message))}>Tare</Button>
          <Button size="sm" variant="secondary" onClick={() => tareBridgeScale(true).catch((e) => setError(e.message))}>Zero</Button>
        </div>
      )}
    </Modal>
  );
}
