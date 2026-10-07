import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ShellComponent } from './features/shell/shell.component';
import { KeyboardNavService } from './core/services/keyboard-nav.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ShellComponent],
  template: `
    <app-shell></app-shell>
  `,
  styles: [`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
  `]
})
export class AppComponent implements OnInit {
  private readonly keyboardNav = inject(KeyboardNavService);

  ngOnInit(): void {
    this.keyboardNav.init();
  }
}
