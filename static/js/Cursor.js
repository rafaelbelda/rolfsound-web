// /static/js/Cursor.js

export default class Cursor {
  constructor() {
    this.dot = document.getElementById('cursor-dot');
    this.mouse = { x: 0, y: 0 }; // Posição real do mouse
    this.pos = { x: 0, y: 0 };   // Posição da pílula (suavizada)
    this.speed = 0.15;           // Velocidade da inércia
    this.isHovering = false;
    this.currentTarget = null;
    
    this.init();
  }

  init() {
    if (!this.dot) return;

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.checkHoverState(e);
    });

    this.render();
  }

  checkHoverState(e) {
    const path = e.composedPath();
    const target = path.find(el => el.classList && el.classList.contains('hover-target'));

    if (target) {
      if (this.currentTarget !== target) {
        this.currentTarget = target;
        this.isHovering = true;
        this.dot.classList.add('hovering');

        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);

        // O container assume o tamanho do botão
        this.dot.style.width = `${rect.width}px`;
        this.dot.style.height = `${rect.height}px`;
        this.dot.style.borderRadius = style.borderRadius;
      }
    } else if (this.isHovering) {
      this.isHovering = false;
      this.currentTarget = null;
      this.dot.classList.remove('hovering');

      // Volta a ser a bolinha normal
      this.dot.style.width = '5px';
      this.dot.style.height = '5px';
      this.dot.style.borderRadius = '50%';
      
      // Reseta o deslocamento da bolinha interna
      this.dot.style.setProperty('--dx', '0px');
      this.dot.style.setProperty('--dy', '0px');
    }
  }

  render() {
    let targetX, targetY;

    if (this.isHovering && this.currentTarget) {
      // 1. O container (pílula) foca no centro do botão
      const rect = this.currentTarget.getBoundingClientRect();
      targetX = rect.left + rect.width / 2;
      targetY = rect.top + rect.height / 2;

      // 2. Calculamos a distância entre o centro e o mouse real
      // Reduzimos o movimento em 40% (0.4) para a bolinha não sair da pílula
      const dx = (this.mouse.x - targetX) * 0.4;
      const dy = (this.mouse.y - targetY) * 0.4;

      this.dot.style.setProperty('--dx', `${dx}px`);
      this.dot.style.setProperty('--dy', `${dy}px`);
    } else {
      // Fora de botões, a pílula (que agora é a bolinha) segue o mouse
      targetX = this.mouse.x;
      targetY = this.mouse.y;
    }

    // Inércia suave (Lerp)
    this.pos.x += (targetX - this.pos.x) * this.speed;
    this.pos.y += (targetY - this.pos.y) * this.speed;

    this.dot.style.transform = `translate3d(calc(${this.pos.x}px - 50%), calc(${this.pos.y}px - 50%), 0)`;
    
    requestAnimationFrame(this.render.bind(this));
  }
}