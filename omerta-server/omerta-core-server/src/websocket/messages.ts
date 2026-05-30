import type { FastifyInstance } from 'fastify';

const clients = new Map<string, any>();

export async function messageWebSocket(app: FastifyInstance) {
  app.get('/ws/messages', { websocket: true }, (socket, req) => {
    const userId = new URL(req.url ?? '', 'http://localhost').searchParams.get('userId') ?? crypto.randomUUID();
    clients.set(userId, socket as any);

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { to?: string; encryptedPayload?: string; messageId?: string };
        if (msg.to && clients.has(msg.to)) {
          clients.get(msg.to)?.send(JSON.stringify({ ...msg, from: userId, routedAt: new Date().toISOString() }));
        }
      } catch {
        socket.send(JSON.stringify({ error: 'INVALID_MESSAGE' }));
      }
    });

    socket.on('close', () => clients.delete(userId));
  });
}
