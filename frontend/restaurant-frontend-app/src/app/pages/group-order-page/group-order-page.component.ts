import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  catchError,
  EMPTY,
  exhaustMap,
  finalize,
  forkJoin,
  map,
  Observable,
  Subscription,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { GroupReservationStatus, GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';

@Component({
  selector: 'app-group-order-page',
  imports: [CurrencyPipe, DatePipe, ModalComponent, ParticipantCardComponent],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly groupOrdersService = inject(GroupOrdersService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private static readonly syncIntervalMs = 15_000;
  private syncSubscription: Subscription | null = null;
  private refreshInProgress = false;

  readonly reservationId = this.route.snapshot.paramMap.get('reservationId') ?? '';
  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly guestSessionId = signal('');
  readonly groupStatus = signal<GroupStatusResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal<'not-found' | 'load-failed' | null>(null);
  readonly isSubmitting = signal(false);
  readonly isSubmitDialogOpen = signal(false);
  readonly lastUpdated = signal<Date | null>(null);
  readonly refreshFailed = signal(false);

  readonly consolidatedPreOrder = computed(() => consolidatePreOrder(this.participants()));
  readonly grandTotal = computed(() => this.consolidatedPreOrder().total);
  readonly unsubmittedParticipantCount = computed(
    () => this.participants().filter((participant) => !participant.isSubmitted).length,
  );
  readonly hasDishes = computed(() => this.participants().some((participant) => participant.items.length > 0));
  readonly statusLabel = computed(() => {
    switch (this.groupStatus()?.status) {
      case 'Open':
        return 'Collecting pre-orders';
      case 'Submitted':
        return 'Sent to Restaurant';
      case 'Closed':
        return 'Closed';
      default:
        return '';
    }
  });
  readonly canSubmit = computed(
    () =>
      this.groupStatus()?.status === 'Open' &&
      !this.loading() &&
      !this.isSubmitting() &&
      this.consolidatedPreOrder().items.length > 0,
  );

  constructor() {
    this.loadGroupOrder();
  }

  loadGroupOrder(): void {
    if (!this.reservationId) {
      this.error.set('not-found');
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.groupOrdersService
      .getGroupInvite$(this.reservationId)
      .pipe(
        switchMap((invite) =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId),
            ownerSessionId: this.groupOrdersService.getOwnerSessionId$(this.reservationId),
            status: this.groupOrdersService.getStatus$(invite.GroupReservationId),
          }).pipe(map((data) => ({ invite, ...data }))),
        ),
      )
      .subscribe({
        next: ({ invite, sessions, ownerSessionId, status }) => {
          this.invite.set(invite);
          this.participants.set(sessions.participants);
          this.guestSessionId.set(ownerSessionId);
          this.groupStatus.set(status);
          this.loading.set(false);
          this.lastUpdated.set(new Date());
          this.refreshFailed.set(false);
          this.startBackgroundSync();
        },
        error: (requestError: unknown) => {
          this.error.set(
            requestError instanceof HttpErrorResponse && requestError.status === 404 ? 'not-found' : 'load-failed',
          );
          this.loading.set(false);
        },
      });
  }

  refreshNow(): void {
    this.refreshGroupData().subscribe();
  }

  openSubmitDialog(): void {
    if (this.canSubmit()) this.isSubmitDialogOpen.set(true);
  }

  closeSubmitDialog(): void {
    if (!this.isSubmitting()) this.isSubmitDialogOpen.set(false);
  }

  submitPreOrder(): void {
    const groupReservationId = this.invite()?.GroupReservationId;
    if (!groupReservationId || !this.canSubmit()) return;

    this.isSubmitting.set(true);
    this.groupOrdersService.submit$(groupReservationId, this.reservationId).subscribe({
      next: () => {
        this.groupStatus.update((status) =>
          status ? { ...status, status: 'Submitted' satisfies GroupReservationStatus } : status,
        );
        this.lastUpdated.set(new Date());
        this.refreshFailed.set(false);
        this.stopBackgroundSync();
        this.isSubmitDialogOpen.set(false);
        this.isSubmitting.set(false);
        this.toast.success('Pre-order sent to the restaurant');
      },
      error: () => {
        this.isSubmitting.set(false);
      },
    });
  }

  private startBackgroundSync(): void {
    if (this.groupStatus()?.status !== 'Open' || this.syncSubscription) return;

    this.syncSubscription = timer(GroupOrderPageComponent.syncIntervalMs, GroupOrderPageComponent.syncIntervalMs)
      .pipe(exhaustMap(() => this.refreshGroupData()), takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  private stopBackgroundSync(): void {
    this.syncSubscription?.unsubscribe();
    this.syncSubscription = null;
  }

  private refreshGroupData(): Observable<void> {
    const groupReservationId = this.invite()?.GroupReservationId;
    if (!groupReservationId || this.groupStatus()?.status !== 'Open' || this.refreshInProgress) return EMPTY;

    this.refreshInProgress = true;
    return forkJoin({
      sessions: this.groupOrdersService.getSessions$(groupReservationId, { silent: true }),
      status: this.groupOrdersService.getStatus$(groupReservationId, { silent: true }),
    }).pipe(
      tap(({ sessions, status }) => {
        this.participants.set(sessions.participants);
        this.groupStatus.set(status);
        this.lastUpdated.set(new Date());
        this.refreshFailed.set(false);
        if (status.status !== 'Open') this.stopBackgroundSync();
      }),
      map(() => undefined),
      catchError(() => {
        this.refreshFailed.set(true);
        return EMPTY;
      }),
      finalize(() => {
        this.refreshInProgress = false;
      }),
    );
  }
}
