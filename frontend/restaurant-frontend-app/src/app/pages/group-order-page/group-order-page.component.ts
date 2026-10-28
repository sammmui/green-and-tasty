import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { GROUP_ORDER_PREVIEW } from '@app/shared/mocks/group-orders/group-order.preview';

@Component({
  selector: 'app-group-order-page',
  imports: [CurrencyPipe, DatePipe, ParticipantCardComponent],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent {
  readonly invite = GROUP_ORDER_PREVIEW.invite;
  readonly participants = signal(GROUP_ORDER_PREVIEW.sessions.participants);
  readonly total = GROUP_ORDER_PREVIEW.sessions.total;
  readonly maxGuestCount = GROUP_ORDER_PREVIEW.invite.MaxGuestCount;
}
