'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './auth';

export type OrderNotification = {
  id: string;           // drop_id
  type: 'delivery' | 'pickup';
  customer_name: string;
  address_short: string;
  materials: string;
  date_label: string;   // e.g. "Apr 19" or "Today"
  arrived_at: number;   // Date.now()
  read: boolean;
};

const POLL_MS = 60_000;

function toDateLabel(isoOrStr: string | null): string {
  if (!isoOrStr) return '—';
  const d = new Date(isoOrStr.includes('T') ? isoOrStr : isoOrStr + 'T12:00:00');
  const today = new Date();
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) return 'Today';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function useOrderNotifications(enabled: boolean, locationId?: string | null) {
  const [toasts, setToasts] = useState<OrderNotification[]>([]);
  const [log, setLog] = useState<OrderNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const seenIds = useRef<Set<string>>(new Set());
  const initialised = useRef(false);

  const poll = useCallback(async () => {
    if (!enabled) return;
    const locQ = locationId ? `?location_id=${locationId}` : '';
    const locA = locationId ? `&location_id=${locationId}` : '';

    const [unschedRes, pickupRes] = await Promise.allSettled([
      api(`/dispatch/unscheduled${locQ}`),
      api(`/pickup/queue${locQ}`),
    ]);

    const newNotifs: OrderNotification[] = [];

    if (unschedRes.status === 'fulfilled') {
      const drops: any[] = unschedRes.value.drops || [];
      for (const drop of drops) {
        if (!seenIds.current.has(drop.drop_id)) {
          seenIds.current.add(drop.drop_id);
          if (initialised.current) {
            newNotifs.push({
              id: drop.drop_id,
              type: 'delivery',
              customer_name: drop.customer_name,
              address_short: drop.address_short || '—',
              materials: drop.items?.join(', ') || '—',
              date_label: toDateLabel(drop.created_at),
              arrived_at: Date.now(),
              read: false,
            });
          }
        }
      }
    }

    if (pickupRes.status === 'fulfilled') {
      const drops: any[] = pickupRes.value.drops || [];
      for (const drop of drops) {
        if (!seenIds.current.has(drop.drop_id)) {
          seenIds.current.add(drop.drop_id);
          if (initialised.current) {
            newNotifs.push({
              id: drop.drop_id,
              type: 'pickup',
              customer_name: drop.customer_name,
              address_short: 'Store pickup',
              materials: drop.items?.slice(0, 3).join(', ') || '—',
              date_label: toDateLabel(drop.created_at),
              arrived_at: Date.now(),
              read: false,
            });
          }
        }
      }
    }

    initialised.current = true;

    if (newNotifs.length > 0) {
      setToasts(prev => [...prev, ...newNotifs]);
      setLog(prev => [...newNotifs, ...prev]);
      setUnreadCount(prev => prev + newNotifs.length);
    }
  }, [enabled, locationId]);

  // Initial load + interval
  useEffect(() => {
    if (!enabled) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, poll]);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    setLog(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  }, []);

  const markAllRead = useCallback(() => {
    setToasts([]);
    setLog(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  }, []);

  return { toasts, log, unreadCount, dismissToast, markAllRead };
}
