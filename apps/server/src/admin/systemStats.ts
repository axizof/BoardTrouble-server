import { cpus, totalmem } from 'node:os';

// Ce que le processus du serveur consomme, pour le tableau de bord : le processeur (en part
// d'un cœur, depuis la dernière mesure) et la mémoire.

export type SystemStats = {
  /** Part d'un cœur utilisée depuis la mesure précédente (0 à 100 par cœur). */
  cpu: number;
  cores: number;
  /** Mémoire du processus (octets) et de la machine. */
  memory: number;
  heap: number;
  totalMemory: number;
};

export class StatsProbe {
  #lastCpu = process.cpuUsage();
  #lastAt = performance.now();

  read(): SystemStats {
    const usage = process.cpuUsage(this.#lastCpu);
    const at = performance.now();
    const elapsed = Math.max(1, at - this.#lastAt) * 1000;
    this.#lastCpu = process.cpuUsage();
    this.#lastAt = at;
    const memory = process.memoryUsage();
    return {
      cpu: Math.round(((usage.user + usage.system) / elapsed) * 1000) / 10,
      cores: cpus().length,
      memory: memory.rss,
      heap: memory.heapUsed,
      totalMemory: totalmem(),
    };
  }
}
