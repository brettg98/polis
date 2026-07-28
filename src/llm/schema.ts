// JSON Schema for SeatAction, used with structured outputs so the model's
// action is schema-valid by construction. Structured outputs require
// additionalProperties: false on every object; all fields are required
// (empty arrays when there's nothing to do) so the shape is unambiguous.

const RESOURCE_QTY = {
  type: 'object',
  additionalProperties: false,
  required: ['resource', 'qty'],
  properties: {
    resource: { type: 'string', enum: ['food', 'energy', 'materials'] },
    qty: { type: 'number', description: 'Amount per tick' },
  },
} as const;

export const SEAT_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliveries', 'responses', 'offers', 'messages', 'memory'],
  properties: {
    deliveries: {
      type: 'array',
      description: 'Shipments against active agreements due this tick',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['agreementId', 'qty'],
        properties: {
          agreementId: { type: 'string' },
          qty: { type: 'number' },
        },
      },
    },
    responses: {
      type: 'array',
      description: 'Decisions on incoming offers',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['offerId', 'decision'],
        properties: {
          offerId: { type: 'string' },
          decision: { type: 'string', enum: ['accept', 'reject'] },
        },
      },
    },
    offers: {
      type: 'array',
      description: 'New trade proposals (give = what you ship per tick)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'give', 'receive', 'duration'],
        properties: {
          to: { type: 'string' },
          give: RESOURCE_QTY,
          receive: RESOURCE_QTY,
          duration: { type: 'integer', description: 'Ticks of deliveries' },
        },
      },
    },
    messages: {
      type: 'array',
      description: 'Free-text messages to other cities, delivered next tick',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'text'],
        properties: {
          to: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
    memory: {
      type: 'string',
      description: 'Your journal, fed back to you verbatim next tick (max ~4000 chars)',
    },
  },
} as const;
