// Local status page: "starting" and the startup / runtime error screens. Everything that comes from
// the URL is shown through textContent, never as markup.
(function () {
  var params = new URLSearchParams(location.search);
  var port = params.get('port') || '';
  var detail = params.get('detail') || '';
  var CONFIG = '%LOCALAPPDATA%\\Switchboard\\config.json';
  var LOG = '~/.switchboard/logs/server.log';

  var screens = {
    wsl_missing: ['WSL을 실행할 수 없습니다', ['Switchboard는 WSL(Windows Subsystem for Linux)에서 서버를 실행합니다.', '관리자 PowerShell에서 wsl --install 을 실행하고 재부팅한 뒤 다시 시도하세요.']],
    port_in_use: ['포트 ' + port + '을(를) 다른 프로그램이 사용 중입니다', ['Switchboard는 포트를 몰래 바꾸지 않습니다.', CONFIG + ' 의 port 값을 비어 있는 포트로 바꾼 뒤 앱을 다시 실행하세요.']],
    stop_failed: ['이전 서버를 종료하지 못했습니다', ['포트 ' + port + '을(를) 이전에 실행한 Switchboard 서버가 쓰고 있습니다.', 'WSL에서 ~/.switchboard/bin/stop 을 실행한 뒤 다시 시도하세요.']],
    start_failed: ['서버가 시작되지 않았습니다', ['시작 스크립트가 종료되었습니다' + (detail ? ' (종료 코드 ' + detail + ')' : '') + '.', '로그: ' + LOG + ' (WSL 안)']],
    health_timeout: ['서버가 제때 응답하지 않았습니다', ['60초 안에 서버가 준비되지 않았습니다.', '로그: ' + LOG + ' (WSL 안)']],
    server_exited: ['서버가 종료되었습니다', ['실행 중이던 서버가 예기치 않게 멈췄습니다' + (detail ? ' (종료 코드 ' + detail + ')' : '') + '.', '앱을 닫고 다시 실행하세요. tmux 세션은 유지됩니다.', '로그: ' + LOG + ' (WSL 안)']],
    config_invalid: ['설정 파일을 읽을 수 없습니다', [CONFIG + ' 을(를) 고치거나 삭제한 뒤 다시 실행하세요.', detail]]
  };

  var root = document.getElementById('root');
  function add(tag, text, cls) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    root.appendChild(el);
    return el;
  }

  if (params.get('state') === 'error') {
    var screen = screens[params.get('code')] || ['문제가 발생했습니다', [detail]];
    root.className = 'err';
    root.setAttribute('role', 'alert');
    add('h1', screen[0]);
    screen[1].forEach(function (line) { if (line) add('p', line); });
  } else {
    var h = add('h1', 'Switchboard');
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    h.prepend(dot);
    add('p', '서버를 시작하는 중입니다…');
  }
})();
