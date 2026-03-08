'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api } from './auth';

export type Location = {
  id: string;
  name: string;
  slug: string;
};

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
