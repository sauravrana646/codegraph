class RetryPolicy:
    def __init__(self, retries: int) -> None:
        self.retries = retries


class PaymentService:
    def __init__(self, retry_policy: RetryPolicy) -> None:
        self.retry_policy = retry_policy

    def create(self, payment_id: str) -> str:
        for _ in range(self.retry_policy.retries):
            if self._send(payment_id):
                return "created"
        return "failed"

    def _send(self, payment_id: str) -> bool:
        return bool(payment_id)


service = PaymentService(RetryPolicy(3))
result = service.create("pay_123")
