import './globals.css';
import AppShell from './lib/app-shell';

export const metadata = {
  title: 'Dispatch & Delivery',
  description: 'V1 scaffold UI',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
