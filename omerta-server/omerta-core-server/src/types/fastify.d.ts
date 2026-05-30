import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: string; type: 'creator' | 'user'; deviceId?: string };
    user: { sub: string; role: string; type: 'creator' | 'user'; deviceId?: string };
  }
}
