import { z } from "zod";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const addressSchema = z.strictObject({
  recipient: z.string().trim().min(1).max(80),
  line1: z.string().trim().min(1).max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().max(80).optional(),
  postal_code: z.string().trim().min(1).max(20),
  country: z.literal("PT")
});
const category = z.enum([
  "delivery",
  "refund",
  "cancellation",
  "address",
  "other"
]);
const orderArgs = z.strictObject({ order_id: idSchema });
export const inputs = {
  get_order: orderArgs,
  list_customer_orders: z.strictObject({
    limit: z.number().int().min(1).max(20).optional(),
    cursor: z.string().min(1).max(256).optional()
  }),
  cancel_order: orderArgs,
  refund_order: orderArgs,
  update_shipping_address: z.strictObject({
    order_id: idSchema,
    address: addressSchema
  }),
  get_customer_profile: z.strictObject({}),
  create_support_ticket: z.strictObject({
    order_id: idSchema.optional(),
    category,
    subject: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000)
  }),
  get_refund_status: z.strictObject({ refund_id: idSchema })
};
export type ToolName = keyof typeof inputs;
export const mutations = new Set<ToolName>([
  "cancel_order",
  "refund_order",
  "update_shipping_address",
  "create_support_ticket"
]);
export const descriptions: Record<ToolName, string> = {
  get_order:
    "Read one of the current customer's orders, items, shipping address, tracking, refund and eligibility. Use the order ID from list_customer_orders.",
  list_customer_orders:
    "List the current customer's previous orders. No customer ID is needed. Use next_cursor for more pages.",
  get_customer_profile:
    "Read the current customer's name, email and saved shipping address. Also verifies the private shop connection.",
  get_refund_status:
    "Read an existing refund's status. Does not execute or restart a refund.",
  cancel_order:
    "Propose cancellation of an unshipped order. Requires clicking Approve on a card. Cancellation never refunds payment.",
  update_shipping_address:
    "Propose a complete shipping address for an unshipped order, after collecting all required fields. Requires a card approval. The saved profile address stays unchanged.",
  create_support_ticket:
    "Propose a support ticket with its complete subject and body for card approval. An optional order must belong to the current customer.",
  refund_order:
    "Read current refund status if pending/completed. Eligible new refunds and confirmed failed retries require fresh card approval. Pending or completed refunds return status only; never create a second attempt for an uncertain outcome."
};
const int = z.number().int();
export const orderSummary = z.strictObject({
  order_id: idSchema,
  fulfillment_status: z.enum([
    "unshipped",
    "cancelled",
    "shipped",
    "delivered"
  ]),
  payment_status: z.enum(["unpaid", "paid", "refunded"]),
  total_minor: int.positive(),
  currency: z.literal("EUR"),
  version: int.positive()
});
export const refundSchema = z.strictObject({
  refund_id: idSchema,
  order_id: idSchema,
  amount_minor: int.positive(),
  currency: z.literal("EUR"),
  status: z.enum(["pending", "completed", "failed"]),
  attempt_number: int.positive(),
  outcome: z.enum(["unknown", "confirmed_succeeded", "confirmed_no_refund"]),
  retry_requires_approval: z.boolean(),
  needs_attention: z.boolean(),
  updated_at: z.string()
});
const actionResult = { action_id: idSchema, replayed: z.boolean() };
export const dataSchemas = {
  get_order: z.strictObject({
    order: orderSummary.extend({
      items: z.array(
        z.strictObject({
          sku: z.string(),
          name: z.string(),
          quantity: int.positive(),
          unit_minor: int.nonnegative(),
          line_minor: int.nonnegative()
        })
      ),
      shipping_address: addressSchema,
      tracking: z
        .strictObject({ carrier: z.string(), tracking_id: z.string() })
        .nullable(),
      refund: refundSchema.nullable(),
      eligibility: z.strictObject({
        can_cancel: z.boolean(),
        can_refund: z.boolean(),
        can_update_address: z.boolean(),
        reasons: z.array(z.string())
      })
    })
  }),
  list_customer_orders: z.strictObject({
    orders: z.array(orderSummary).max(20),
    next_cursor: z.string().nullable()
  }),
  get_customer_profile: z.strictObject({
    customer: z.strictObject({
      customer_id: idSchema,
      display_name: z.string(),
      email: z.string(),
      saved_shipping_address: addressSchema
    })
  }),
  get_refund_status: z.strictObject({ refund: refundSchema }),
  refund_order: z.strictObject({
    refund: refundSchema,
    action_id: idSchema.nullable(),
    replayed: z.boolean(),
    disposition: z.enum(["accepted", "status_only", "retry_accepted"])
  }),
  cancel_order: z.strictObject({
    ...actionResult,
    order: orderSummary,
    payment_unchanged: z.literal(true),
    notice: z.string(),
    offer_refund: z.boolean()
  }),
  update_shipping_address: z.strictObject({
    ...actionResult,
    order: orderSummary,
    shipping_address: addressSchema,
    profile_address_unchanged: z.literal(true)
  }),
  create_support_ticket: z.strictObject({
    ...actionResult,
    ticket: z.strictObject({
      ticket_id: idSchema,
      order_id: idSchema.nullable(),
      category,
      subject: z.string(),
      body: z.string(),
      status: z.literal("open"),
      created_at: z.string()
    })
  })
};
export const proposalViewSchema = z.strictObject({
  actionId: idSchema,
  digest: z.string(),
  tool: z.string(),
  payload: z.unknown(),
  state: z.string(),
  expiresAt: z.string(),
  decision: z.string(),
  result: z.unknown().optional()
});
export const failureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean()
  }),
  request_id: z.string(),
  proposal: proposalViewSchema.optional()
});
export function outputSchema(name: ToolName) {
  return z.union([
    z.strictObject({
      ok: z.literal(true),
      data: dataSchemas[name],
      request_id: z.string()
    }),
    failureSchema
  ]);
}
export type CommerceResult =
  | { ok: true; data: Record<string, unknown>; request_id: string }
  | z.infer<typeof failureSchema>;
