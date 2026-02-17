import './globals.css';

export const metadata = {
  title: 'Dispatch & Delivery',
  description: 'V1 scaffold UI',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
