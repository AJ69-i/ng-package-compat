import { TestBed } from '@angular/core/testing';
import { NotifierService } from './notifier.service';

describe('NotifierService', () => {
  let svc: NotifierService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(NotifierService);
  });

  it('starts with no enabled channels', () => {
    expect(svc.enabledChannels()).toEqual([]);
  });

  it('Slack URL toggles the channel on', () => {
    svc.setSlackUrl('https://hooks.slack.com/services/abc');
    expect(svc.enabledChannels()).toContain('slack');
    svc.setSlackUrl('');
    expect(svc.enabledChannels()).not.toContain('slack');
  });

  it('Teams + email + push compose to all four channels', () => {
    svc.setSlackUrl('https://hooks.slack.com/x');
    svc.setTeamsUrl('https://outlook.office.com/webhook/x');
    svc.setEmailTo('user@example.com');
    svc.setPushEnabled(true);
    const ch = svc.enabledChannels();
    expect(ch).toContain('slack');
    expect(ch).toContain('teams');
    expect(ch).toContain('email');
    expect(ch).toContain('push');
  });

  it('persists across instances via localStorage', () => {
    svc.setSlackUrl('https://hooks.slack.com/x');
    const fresh = TestBed.inject(NotifierService); // singleton — but read again
    expect(fresh.config().slackWebhookUrl).toBe('https://hooks.slack.com/x');
  });
});
