import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService, RefundRequest } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService, private readonly config: ConfigService) {}

  @Get('accounts/:accountId/invoices')
  invoices(@Param('accountId') accountId: string, @Query('limit') limit?: string) {
    return this.billing.listInvoices(accountId, limit ? Number(limit) : 25);
  }

  @Get('invoices/:invoiceId')
  invoice(@Param('invoiceId') invoiceId: string) {
    return this.billing.getInvoice(invoiceId);
  }

  @Post('invoices/:invoiceId/pay')
  pay(@Param('invoiceId') invoiceId: string) {
    return this.billing.payInvoice(invoiceId);
  }

  @Post('invoices/:invoiceId/finalize')
  finalize(@Param('invoiceId') invoiceId: string) {
    return this.billing.finalizeInvoice(invoiceId);
  }

  @Post('invoices/:invoiceId/void')
  voidInvoice(@Param('invoiceId') invoiceId: string) {
    return this.billing.voidInvoice(invoiceId);
  }

  @Post('invoices/:invoiceId/uncollectible')
  uncollectible(@Param('invoiceId') invoiceId: string) {
    return this.billing.markUncollectible(invoiceId);
  }

  @Post('accounts/:accountId/refund')
  refund(@Param('accountId') accountId: string, @Body() body: RefundRequest) {
    return this.billing.refundInvoice(accountId, body);
  }

  @Get('accounts/:accountId/credit-notes')
  creditNotes(@Param('accountId') accountId: string) {
    return this.billing.listCreditNotes(accountId);
  }

  @Get('accounts/:accountId/refunds')
  refunds(@Param('accountId') accountId: string) {
    return this.billing.listRefunds(accountId);
  }

  /** Pushes the local policy into a Stripe Customer Portal configuration. */
  @Post('portal/configuration')
  syncPortal() {
    return this.billing.syncPortalConfiguration();
  }

  @Post('accounts/:accountId/portal-session')
  portalSession(@Param('accountId') accountId: string, @Body() body: { returnUrl?: string; configurationId?: string }) {
    const fallback = this.config.get<string>('frontendUrl') ?? 'http://localhost:5555';
    return this.billing.createPortalSession(accountId, body?.returnUrl ?? fallback, body?.configurationId);
  }
}
