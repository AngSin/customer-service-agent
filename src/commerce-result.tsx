import {
  dataSchemas,
  inputs,
  outputSchema,
  type ToolName
} from "../shared/commerce-contract";

const euros = (minor: number) => `${(minor / 100).toFixed(2)} EUR`;
function Address({ value }: { value: Record<string, string> }) {
  return (
    <p className="whitespace-pre-wrap">
      {Object.values(value).filter(Boolean).join("\n")}
    </p>
  );
}
export function CommerceResultView({
  name,
  result
}: {
  name: string;
  result: unknown;
}) {
  if (!(name in inputs)) return null;
  const parsed = outputSchema(name as ToolName).safeParse(result);
  if (!parsed.success)
    return <p role="alert">Unable to display the shop result. Please retry.</p>;
  const output = parsed.data;
  if (!output.ok)
    return (
      <p role={output.error.code === "APPROVAL_REQUIRED" ? "status" : "alert"}>
        {output.error.code === "APPROVAL_REQUIRED"
          ? "Approval was requested. If still pending, review the highlighted card above the message field and click its Approve button to continue. Otherwise, check Previous actions for its current status."
          : name === "refund_order" && output.error.code === "NOT_ELIGIBLE"
            ? "A refund cannot start yet. Refunds require a paid order that is cancelled, shipped, or delivered. For a paid unshipped order, approve cancellation first, then request a separate refund approval."
            : output.error.message}
      </p>
    );
  const data = output.data;
  if (name === "list_customer_orders") {
    const { orders, next_cursor } =
      dataSchemas.list_customer_orders.parse(data);
    return (
      <div>
        <p>Verified shop orders</p>
        {orders.length ? (
          <ul>
            {orders.map((order) => (
              <li key={order.order_id}>
                {order.order_id} — {euros(order.total_minor)} —{" "}
                {order.fulfillment_status}, {order.payment_status}
              </li>
            ))}
          </ul>
        ) : (
          <p>No orders found.</p>
        )}
        {next_cursor && (
          <p>More orders are available. Ask for the next page.</p>
        )}
      </div>
    );
  }
  if (name === "get_customer_profile") {
    const { customer } = dataSchemas.get_customer_profile.parse(data);
    return (
      <div>
        <p>Connected to the shop as {customer.display_name}.</p>
        <p>{customer.email}</p>
        <p>Saved shipping address:</p>
        <Address value={customer.saved_shipping_address} />
      </div>
    );
  }
  if (name === "get_order") {
    const { order } = dataSchemas.get_order.parse(data);
    return (
      <div className="space-y-2">
        <p>
          {order.order_id} — {euros(order.total_minor)} —{" "}
          {order.fulfillment_status}, {order.payment_status}
        </p>
        <ul>
          {order.items.map((item, i) => (
            <li key={i}>
              {item.name} × {item.quantity} — {euros(item.line_minor)}
            </li>
          ))}
        </ul>
        <p>Shipping address:</p>
        <Address value={order.shipping_address} />
        {order.tracking && (
          <p>
            Tracking: {order.tracking.carrier} / {order.tracking.tracking_id}
          </p>
        )}
        {order.refund && (
          <p>
            Refund {order.refund.refund_id}: {order.refund.status}
          </p>
        )}
        <p>
          {order.eligibility.can_cancel
            ? "Cancellation available with approval."
            : "Cancellation unavailable."}{" "}
          {order.eligibility.can_update_address
            ? "Address change available with approval."
            : "Address change unavailable."}
        </p>
      </div>
    );
  }
  if (name === "cancel_order") {
    const result = dataSchemas.cancel_order.parse(data);
    return (
      <div>
        <p>{result.notice}</p>
        {result.offer_refund && (
          <p>A full refund needs separate approval. Ask to request a refund.</p>
        )}
      </div>
    );
  }
  if (name === "update_shipping_address") {
    const result = dataSchemas.update_shipping_address.parse(data);
    return (
      <div>
        <p>
          Shipping address updated for {result.order.order_id}. Your saved
          profile address is unchanged.
        </p>
        <Address value={result.shipping_address} />
      </div>
    );
  }
  if (name === "create_support_ticket") {
    const { ticket } = dataSchemas.create_support_ticket.parse(data);
    return (
      <div>
        <p>Support ticket {ticket.ticket_id} is open.</p>
        <p>{ticket.subject}</p>
        <p className="whitespace-pre-wrap">{ticket.body}</p>
      </div>
    );
  }
  const refund = dataSchemas.get_refund_status.parse({
    refund: (data as { refund: unknown }).refund
  }).refund;
  return (
    <p>
      Refund {refund.refund_id}: {refund.status} — {euros(refund.amount_minor)}.
      {refund.needs_attention
        ? " Processing needs attention; the outcome is still pending. Do not start another refund."
        : ""}
      {refund.retry_requires_approval
        ? " A retry requires a new proposal and separate approval."
        : ""}
    </p>
  );
}
