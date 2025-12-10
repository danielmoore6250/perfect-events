import { useRef } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { Navigation } from 'swiper/modules';
import 'swiper/css';
import 'swiper/css/navigation';
import '../styles/ReviewCarousel.css';
import reviewsData from '../data/reviews.json';

function ReviewCarousel() {
  const swiperRef = useRef(null);
  const reviews = reviewsData.reviews;

  return (
    <div className="review-carousel-container">
      <Swiper
        ref={swiperRef}
        modules={[Navigation]}
        navigation={{
          nextEl: '.swiper-button-next',
          prevEl: '.swiper-button-prev',
        }}
        spaceBetween={30}
        slidesPerView={2}
        loop={true}
        className="review-swiper"
        breakpoints={{
          0: {
            slidesPerView: 1,
          },
          768: {
            slidesPerView: 2,
          },
        }}
      >
        {reviews.map((review) => (
          <SwiperSlide key={review.id} className="review-slide">
            <div className="review-card">
              <div className="stars">
                {[...Array(review.rating)].map((_, i) => (
                  <span key={i}>⭐</span>
                ))}
              </div>
              <p className="review-text">"{review.text}"</p>
              <p className="review-author">— {review.name}</p>
              <p className="review-event">{review.event}</p>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
      <div className="swiper-button-prev"></div>
      <div className="swiper-button-next"></div>
    </div>
  );
}

export default ReviewCarousel;
