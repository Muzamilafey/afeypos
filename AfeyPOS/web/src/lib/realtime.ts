import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { getAccessToken } from './api';

let socket: Socket | null = null;

export function connectRealtime(): Socket | null {
  const token = getAccessToken();
  if (!token) return null;
  if (socket?.connected) return socket;
  socket?.disconnect();
  socket = io({ path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });
  socket.on('connect_error', () => {
    // Token may have rotated; reconnect with the latest one.
    if (socket) socket.auth = { token: getAccessToken() };
  });
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}

export function useRealtime(event: string, handler: (data: any) => void, deps: unknown[] = []) {
  useEffect(() => {
    const s = connectRealtime();
    if (!s) return;
    s.on(event, handler);
    return () => {
      s.off(event, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}
