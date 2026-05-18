'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api } from './auth';

export type Location = {
  id: string;
  name: string;
  slug: string;
  windowA_start: string | null;
  windowA_end: string | null;
  windowB_start: string | null;
  windowB_end: string | null;
  window_dow_rules?: {
    A?: { disabled_days?: number[]; day_overrides?: Record<string, { start: string; end: string }> };
    B?: { disabled_days?: number[]; day_overrides?: Record<string, { start: string; end: string }> };
  } | null;
};

/** Format a window time range from location settings, respecting per-DOW overrides.
 *  dateStr is optional YYYY-MM-DD. If omitted, returns the global default. */
export function fmtWindowRange(win: 'A' | 'B', location: Location | null, dateStr?: string | null): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  };

  // Check for a per-DOW override when a date is provided
  if (dateStr && location?.window_dow_rules) {
    // JS getDay(): 0=Sun,1=Mon,...,6=Sat — convert to Python weekday: 0=Mon,...,6=Sun
    const jsDay = new Date(dateStr + 'T12:00:00').getDay();
    const pyDay = jsDay === 0 ? 6 : jsDay - 1;
    const override = location.window_dow_rules[win]?.day_overrides?.[String(pyDay)];
    if (override) return `${fmt(override.start)}–${fmt(override.end)}`;
  }

  const start = win === 'A' ? location?.windowA_start : location?.windowB_start;
  const end   = win === 'A' ? location?.windowA_end   : location?.windowB_end;
  if (!start || !end) return win === 'A' ? '9am–1pm' : '1pm–5pm';
  return `${fmt(start)}–${fmt(end)}`;
}

type LocationContextValue = {
  locations: Location[];
  activeLocation: Location | null;
  setActiveLocation: (loc: Location) => void;
  loading: boolean;
};

const LocationContext = createContext<LocationContextValue>({
  locations: [],
  activeLocation: null,
  setActiveLocation: () => {},
  loading: true,
});

const STORAGE_KEY = 'activeLocationId';

export function LocationProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [activeLocation, setActiveLocationState] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchLocations = useCallback(async () => {
    try {
      const data = await api('/locations');
      const locs: Location[] = data.locations || [];
      setLocations(locs);

      if (locs.length === 0) { setLoading(false); return; }

      const stored = localStorage.getItem(STORAGE_KEY);
      const matched = stored ? locs.find(l => l.id === stored) : null;
      setActiveLocationState(matched ?? locs[0]);
    } catch {
      // silently fail — pages will handle missing location_id gracefully
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) fetchLocations();
    else setLoading(false);
  }, [enabled, fetchLocations]);

  const setActiveLocation = useCallback((loc: Location) => {
    setActiveLocationState(loc);
    localStorage.setItem(STORAGE_KEY, loc.id);
  }, []);

  return (
    <LocationContext.Provider value={{ locations, activeLocation, setActiveLocation, loading }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  return useContext(LocationContext);
}
