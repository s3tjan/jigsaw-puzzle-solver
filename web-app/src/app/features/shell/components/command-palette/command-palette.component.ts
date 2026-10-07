import { Component, ElementRef, ViewChild, AfterViewInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AppModeStore } from '../../../../core/state/app-mode.store';
import { AppMode } from '../../../../core/models/operator.model';

interface CommandItem {
  id: string;
  label: string;
  category: string;
  shortcut: string;
  action: () => void;
}

@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './command-palette.component.html',
  styleUrl: './command-palette.component.css'
})
export class CommandPaletteComponent implements AfterViewInit {
  private readonly appModeStore = inject(AppModeStore);

  @ViewChild('searchInput') private readonly searchInput!: ElementRef<HTMLInputElement>;

  readonly query = signal<string>('');
  readonly selectedIndex = signal<number>(0);

  private readonly commands: CommandItem[] = [
    {
      id: 'mode-ingestion',
      label: 'SWITCH MODE: CONTINUOUS MAT INGESTION',
      category: 'VIEW',
      shortcut: 'Alt+1',
      action: () => this.setMode('INGESTION')
    },
    {
      id: 'mode-poster',
      label: 'SWITCH MODE: POSTER ANALYSIS & TRAY CLUSTERING STUDIO',
      category: 'VIEW',
      shortcut: 'Alt+2',
      action: () => this.setMode('POSTER_STUDIO')
    },
    {
      id: 'mode-workbench',
      label: 'SWITCH MODE: ASSEMBLY WORKBENCH & SPOTTING HUD',
      category: 'VIEW',
      shortcut: 'Alt+3',
      action: () => this.setMode('WORKBENCH')
    },
    {
      id: 'toggle-rail',
      label: 'TOGGLE FRONTIER QUEUE RAIL',
      category: 'LAYOUT',
      shortcut: 'Alt+B',
      action: () => {
        this.appModeStore.toggleLeftRail();
        this.close();
      }
    },
    {
      id: 'calibrate-optics',
      label: 'CALIBRATE OPTICS (K1 DISTORTION)',
      category: 'OPTICS',
      shortcut: 'OPT-03',
      action: () => {
        this.close();
      }
    }
  ];

  readonly filteredCommands = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) {
      return this.commands;
    }
    return this.commands.filter(cmd =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.category.toLowerCase().includes(q) ||
      cmd.shortcut.toLowerCase().includes(q)
    );
  });

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.searchInput?.nativeElement.focus();
    }, 0);
  }

  onKeyDown(event: KeyboardEvent): void {
    const items = this.filteredCommands();
    if (items.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedIndex.update(idx => (idx + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedIndex.update(idx => (idx - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = items[this.selectedIndex()];
      if (selected) {
        selected.action();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  execute(command: CommandItem): void {
    command.action();
  }

  close(): void {
    this.appModeStore.closeCommandPalette();
  }

  private setMode(mode: AppMode): void {
    this.appModeStore.setMode(mode);
    this.close();
  }
}
