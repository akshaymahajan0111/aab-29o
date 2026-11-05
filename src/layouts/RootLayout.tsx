import { Helmet } from '@dr.pogodin/react-helmet';
import { type ReactElement } from 'react';
import { ScrollRestoration } from 'react-router';

import Website from '@/layouts/Website';

interface RootLayoutProps {
  children: ReactElement;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <Website>
      <Helmet>
        <title>Colour Vision Test</title>
        <meta name="description" content="Test your colour perception — spot the odd one out!" />
      </Helmet>
      <ScrollRestoration />
      {children}
    </Website>
  );
}
