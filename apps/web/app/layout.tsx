import './globals.css';
import AppShell from './lib/app-shell';

export const metadata = {
  title: 'East Meadow Dispatch',
  description: 'Delivery dispatch and operations platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
