'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from './lib/auth';

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    const s = getSession();
    if (!s) { router.replace('/login'); return; }
    router.replace(s.role === 'driver' ? '/driver/loads' : '/ops-dashboard');
  }, [router]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div className="spinner spinner-lg" />
    </div>
  );
}
