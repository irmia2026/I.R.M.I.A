import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import 'page_chrome.dart';

const _emotionLabels = <String, String>{
  'joy': '愉快',
  'distress': '低落',
  'concern': '关切',
  'irritation': '不悦',
  'warmth': '亲近',
  'shyness': '害羞',
};

const _reasonLabels = <String, String>{
  'general': '综合',
  'praise': '被认可',
  'criticism': '被批评',
  'ignored': '被忽略',
  'unwelcome_advance': '越界',
  'repair': '和解',
};

class MoodPage extends StatefulWidget {
  const MoodPage({super.key, required this.state});
  final AppState state;

  @override
  State<MoodPage> createState() => _MoodPageState();
}

class _MoodPageState extends State<MoodPage> {
  bool loading = true;
  String? error;
  Map<String, dynamic>? view;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = view == null;
      error = null;
    });
    try {
      final raw = await widget.state.api.get('/api/plugin/linre-affect/state');
      if (!mounted) return;
      setState(() {
        view = (raw as Map).cast<String, dynamic>();
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  Map<String, dynamic> get _emotions =>
      ((view?['emotions'] as Map?) ?? const {}).cast<String, dynamic>();

  List<Map<String, dynamic>> get _history =>
      ((view?['history'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  List<Map<String, dynamic>> get _causes =>
      ((view?['causes'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  String get _renderLine => (view?['renderLine'] as String?) ?? '情绪：平稳。';

  String get _dominant {
    final key = (view?['dominant'] as String?) ?? '';
    return _emotionLabels[key] ?? '平稳';
  }

  double get _strength => ((view?['strength'] as num?) ?? 0).toDouble();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        PageHeader(
          title: '情绪',
          subtitle: '此刻的状态；数据来自 linre-affect 插件',
          action: IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh_rounded, size: 18),
            tooltip: '刷新',
          ),
        ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('读取失败：$error', textAlign: TextAlign.center),
                            const SizedBox(height: 12),
                            FilledButton.tonal(onPressed: _load, child: const Text('重试')),
                          ],
                        ),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
                      children: [
                        _hero(),
                        const SizedBox(height: 14),
                        _mixCard(),
                        const SizedBox(height: 14),
                        _timelineCard(),
                        const SizedBox(height: 14),
                        _factorsCard(),
                      ],
                    ),
        ),
      ],
    );
  }

  Widget _card({required Widget child, EdgeInsets padding = const EdgeInsets.all(18)}) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: MoodPalette.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: MoodPalette.edge),
      ),
      child: child,
    );
  }

  Widget _sectionTitle(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(
        text,
        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: MoodPalette.title),
      ),
    );
  }

  Widget _hero() {
    final mood = ((view?['mood'] as Map?) ?? const {}).cast<String, dynamic>();
    final valence = ((mood['valence'] as num?) ?? 0).toDouble();
    final arousal = ((mood['arousal'] as num?) ?? 0).toDouble();
    final neutral = view?['neutral'] == true;
    final color = MoodPalette.emotionColor(_dominantKey);
    return _card(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withValues(alpha: 0.13),
              border: Border.all(color: color.withValues(alpha: 0.42)),
            ),
            alignment: Alignment.center,
            child: Text(
              neutral ? '稳' : _dominant.substring(0, 1),
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: color),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _renderLine,
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: MoodPalette.heading, height: 1.35),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    _pill('主导', neutral ? '平稳' : '$_dominant ${(_strength * 100).round()}%'),
                    const SizedBox(width: 8),
                    _pill('心境', _moodWord(valence)),
                    const SizedBox(width: 8),
                    _pill('唤醒', '${(arousal * 100).round()}%'),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String get _dominantKey {
    final key = (view?['dominant'] as String?) ?? '';
    return _emotionLabels.containsKey(key) ? key : '';
  }

  String _moodWord(double valence) {
    if (valence > 0.12) return '偏暖';
    if (valence < -0.12) return '偏冷';
    return '居中';
  }

  Widget _pill(String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: MoodPalette.chipBg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: MoodPalette.chipBorder),
      ),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(text: '$label ', style: const TextStyle(fontSize: 11, color: MoodPalette.muted)),
            TextSpan(text: value, style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: MoodPalette.ink)),
          ],
        ),
      ),
    );
  }

  Widget _mixCard() {
    final emotions = _emotions;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sectionTitle('情绪构成'),
          for (final entry in emotions.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: _EmotionBar(
                emotionKey: entry.key,
                value: (entry.value as num?)?.toDouble() ?? 0,
              ),
            ),
        ],
      ),
    );
  }

  Widget _timelineCard() {
    final points = _history;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sectionTitle('心境轨迹'),
          if (points.isEmpty)
            const SizedBox(
              height: 72,
              child: Center(
                child: Text('还没有评价记录', style: TextStyle(fontSize: 12, color: MoodPalette.mutedSoft)),
              ),
            )
          else
            SizedBox(
              height: 104,
              child: CustomPaint(painter: _TimelinePainter(points: points), size: Size.infinite),
            ),
        ],
      ),
    );
  }

  Widget _factorsCard() {
    final causes = _causes;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sectionTitle('最近的影响'),
          if (causes.isEmpty)
            const Text('还没有影响记录', style: TextStyle(fontSize: 12, color: MoodPalette.mutedSoft))
          else
            for (final cause in causes)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Row(
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: MoodPalette.emotionColor('${cause['dominantEmotion'] ?? ''}'),
                      ),
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Text(
                        _reasonLabels['${cause['reasonCode'] ?? 'general'}'] ?? '综合',
                        style: const TextStyle(fontSize: 12.5, color: MoodPalette.ink),
                      ),
                    ),
                    Text(
                      '${(((cause['strength'] as num?) ?? 0) * 100).round()}%',
                      style: const TextStyle(fontSize: 12, color: MoodPalette.muted),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

class _EmotionBar extends StatelessWidget {
  const _EmotionBar({required this.emotionKey, required this.value});

  final String emotionKey;
  final double value;

  @override
  Widget build(BuildContext context) {
    final color = MoodPalette.emotionColor(emotionKey);
    final v = value.clamp(0.0, 1.0).toDouble();
    return Row(
      children: [
        SizedBox(
          width: 70,
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  boxShadow: [BoxShadow(color: color.withValues(alpha: 0.13), spreadRadius: 3)],
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  _emotionLabels[emotionKey] ?? emotionKey,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: MoodPalette.ink),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: SizedBox(
            height: 6,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  const ColoredBox(color: MoodPalette.track),
                  FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: v,
                    child: ColoredBox(color: color),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 38,
          child: Text(
            '${(v * 100).round()}%',
            textAlign: TextAlign.right,
            style: const TextStyle(fontSize: 11.5, color: MoodPalette.muted),
          ),
        ),
      ],
    );
  }
}

class _TimelinePainter extends CustomPainter {
  _TimelinePainter({required this.points});

  final List<Map<String, dynamic>> points;

  @override
  void paint(Canvas canvas, Size size) {
    final grid = Paint()
      ..color = MoodPalette.chartGrid
      ..strokeWidth = 1;
    for (var i = 0; i <= 4; i += 1) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    final zeroY = size.height / 2;
    canvas.drawLine(Offset(0, zeroY), Offset(size.width, zeroY), grid);

    if (points.isEmpty) return;
    final path = Path();
    for (var i = 0; i < points.length; i += 1) {
      final x = points.length == 1 ? size.width / 2 : size.width * i / (points.length - 1);
      final valence = ((points[i]['valence'] as num?) ?? 0).toDouble().clamp(-1.0, 1.0);
      final y = zeroY - valence * (size.height / 2 - 6);
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = MoodPalette.chartLine
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
    for (var i = 0; i < points.length; i += 1) {
      final x = points.length == 1 ? size.width / 2 : size.width * i / (points.length - 1);
      final valence = ((points[i]['valence'] as num?) ?? 0).toDouble().clamp(-1.0, 1.0);
      final y = zeroY - valence * (size.height / 2 - 6);
      canvas.drawCircle(Offset(x, y), 2.5, Paint()..color = MoodPalette.chartLine);
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) => oldDelegate.points != points;
}
