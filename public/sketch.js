var socket;

function setup() {
  createCanvas(600, 400);
  background(220);
  socket = io.connect('https://socket-drawing00.onrender.com');
  socket.on('mouse', newDrawing);
}

function newDrawing(data) {
  noStroke();
  fill(255, 0, 100);
  rect(data.x, data.y, 20, 20);
}

function mouseDragged() {
  console.log(mouseX + ',' + mouseY);

var data ={
  x: mouseX,
  y: mouseY
}

socket.emit('mouse', data);

  noStroke();
  fill(255);
  rect(mouseX, mouseY, 20, 20);
}

function draw() {

}
