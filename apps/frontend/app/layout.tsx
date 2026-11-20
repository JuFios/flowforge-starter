import { Navigation } from '@/components/navigation';
import './styles.css';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'FlowForge · Робочий простір' };
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="uk">
      <body>
        <Navigation />
        <main>{children}</main>
      </body>
    </html>
  );
}
