import { NextResponse, type NextRequest } from 'next/server';

/**
 * Global CORS middleware for the channel proxy.
 * Allows cross-origin requests from the AI BPO frontend.
 */
export function middleware(req: NextRequest) {
  // Handle preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(req),
    });
  }

  // Add CORS headers to all responses
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders(req))) {
    response.headers.set(key, value);
  }
  return response;
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export const config = {
  matcher: '/api/:path*',
};
